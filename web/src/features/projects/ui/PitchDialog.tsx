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
import { AlertTriangle, ArrowRight, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { existingUserPubkey, userPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { TechnicalDetails } from "@/shared/ui/technical-details";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { Modal } from "@/features/launchpad/ui/Modal";
import {
  Segmented,
  Stepper,
} from "@/features/launchpad/ui/create-wizard/fields";
import {
  PitchField,
  RoleRowInputs,
  StakeSummary,
  type RoleRow,
} from "./PitchFields";
import {
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  MAX_ROLES,
  MAX_SUMMARY_LEN,
  PitchValidationError,
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

type Step = "project" | "team";

const STEPS = [
  { key: "project", label: "Project" },
  { key: "team", label: "Team & stake" },
];
const MODES: { value: Mode; label: string; hint: string }[] = [
  {
    value: "new",
    label: "New project",
    hint: "Give your idea a home on the project board.",
  },
  {
    value: "node",
    label: "Existing team",
    hint: "Add a pitch to a team you already run.",
  },
  {
    value: "launch",
    label: "From a launch",
    hint: "Connect your pitch to a launch you already created.",
  },
];

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

  const [step, setStep] = useState<Step>("project");
  const [addressOpen, setAddressOpen] = useState(false);
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
    field: PitchValidationError["field"];
    message: string;
  } | null>(null);
  const [lastInput, setLastInput] = useState<CreatePitchInput | null>(null);
  const publishErrorRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    if (!open) return;
    const id = fieldError
      ? {
          nodeId:
            mode === "new"
              ? "pitch-id"
              : mode === "node"
                ? "pitch-node"
                : "pitch-launch",
          name: "pitch-name",
          summary: "pitch-summary",
          description: "pitch-description",
          roles: "role-label-0",
        }[fieldError.field]
      : step === "project"
        ? "pitch-name"
        : "role-label-0";
    if (id) document.getElementById(id)?.focus();
  }, [open, step, fieldError, mode]);

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

  function buildInput(): CreatePitchInput {
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
    return { pitch, node };
  }

  function showValidation(error: PitchValidationError) {
    setFieldError({ field: error.field, message: error.message });
    setStep(error.field === "roles" ? "team" : "project");
    if (error.field === "nodeId" && mode === "new") setAddressOpen(true);
  }

  function publish(next: CreatePitchInput) {
    if (create.isPending) return;
    setLastInput(next);
    create.mutate(next, {
      onSuccess: (result) => {
        onOpenChange(false);
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: result.nodeId },
          search: { action: undefined, author: userPubkey() },
        });
      },
      onError: (error) => {
        if (error instanceof PitchValidationError) showValidation(error);
      },
    });
  }

  function advance() {
    if (create.isPending) return;
    setFieldError(null);
    const next = buildInput();
    // A blank name has no derived address yet. Ask for the name first.
    if (!name.trim()) {
      showValidation(
        new PitchValidationError("name", "Give your project a name."),
      );
      return;
    }
    try {
      // Every project field is checked before continuing; role issues belong
      // to the next step. The final action validates the entire snapshot again.
      buildPitchTemplate(next.pitch);
    } catch (error) {
      if (!(error instanceof PitchValidationError)) throw error;
      if (error.field !== "roles") {
        showValidation(error);
        return;
      }
    }
    setStep("team");
  }

  function submit() {
    if (create.isPending) return;
    setFieldError(null);
    const next = buildInput();
    try {
      // Validate before either write: a rejected pitch must not leave a node.
      buildPitchTemplate(next.pitch);
    } catch (error) {
      if (error instanceof PitchValidationError) {
        showValidation(error);
        return;
      }
      throw error;
    }
    publish(next);
  }

  const publishError = create.isError ? create.error : null;
  const partial =
    publishError instanceof PitchPublishError && publishError.nodePublished
      ? publishError
      : null;

  useEffect(() => {
    if (open && publishError) {
      publishErrorRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [open, publishError]);

  const errorFor = (field: PitchValidationError["field"]) =>
    fieldError?.field === field ? fieldError.message : null;
  const sourceMissing =
    (mode === "node" && !selectedNode) ||
    (mode === "launch" && !selectedLaunch);
  const roleError = errorFor("roles");
  const close = () => {
    if (!create.isPending) onOpenChange(false);
  };

  if (!open) return null;

  return (
    <Modal label="Pitch a project" onClose={close} wide>
      <form
        className="flex max-h-[calc(100dvh-4.5rem)] flex-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (step === "project") advance();
          else submit();
        }}
      >
        <header className="flex shrink-0 items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Pitch a project</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Share the idea and the team you need. Publish when you're ready.
            </p>
          </div>
          <Button
            aria-label="Close pitch form"
            className="-mr-2 -mt-1 shrink-0 text-muted-foreground"
            disabled={create.isPending}
            onClick={close}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </header>

        <div className="mt-4 shrink-0 border-b border-border/60 pb-3">
          <Stepper
            current={step}
            currentTitle={
              step === "project"
                ? "What are you building?"
                : "Who will build it with you?"
            }
            label="Steps to pitch a project"
            steps={STEPS}
          />
        </div>

        <section
          aria-label={step === "project" ? "Project details" : "Team and stake"}
          className="min-h-0 overflow-y-auto overscroll-contain py-4 pr-1"
          data-testid="pitch-form-scroll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll the form without leaving its fields.
          tabIndex={0}
        >
          <fieldset className="min-w-0 space-y-4" disabled={create.isPending}>
            <legend className="sr-only">
              {step === "project" ? "Project details" : "Team and stake"}
            </legend>
            {step === "project" ? (
              <>
                <div className="rounded-xl border border-border/60 bg-foreground/[0.04] p-3">
                  <Segmented
                    label="Start from"
                    onChange={setMode}
                    options={MODES}
                    value={mode}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {MODES.find((option) => option.value === mode)?.hint}
                  </p>
                  {mode === "node" ? (
                    <div className="mt-3">
                      <PitchField
                        error={errorFor("nodeId")}
                        hint="Choose a team you own to add it to the project board."
                        id="pitch-node"
                        label="Your team"
                      >
                        <select
                          aria-describedby="pitch-node-feedback"
                          aria-invalid={
                            Boolean(errorFor("nodeId")) || undefined
                          }
                          className="h-10 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                          id="pitch-node"
                          onChange={(event) =>
                            setSelectedNode(event.target.value)
                          }
                          value={selectedNode}
                        >
                          <option value="">Choose a team…</option>
                          {existingNodes.map((node) => (
                            <option
                              key={`${node.author}:${node.id}`}
                              value={node.id}
                            >
                              {node.name}
                            </option>
                          ))}
                        </select>
                      </PitchField>
                      {existingNodes.length === 0 ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          No team of yours yet. Choose New project to start one.
                        </p>
                      ) : null}
                    </div>
                  ) : mode === "launch" ? (
                    <div className="mt-3">
                      <PitchField
                        error={errorFor("nodeId")}
                        hint="The project and launch will share a page address."
                        id="pitch-launch"
                        label="Launch"
                      >
                        <select
                          aria-describedby="pitch-launch-feedback"
                          aria-invalid={
                            Boolean(errorFor("nodeId")) || undefined
                          }
                          className="h-10 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                          id="pitch-launch"
                          onChange={(event) => pickLaunch(event.target.value)}
                          value={selectedLaunch}
                        >
                          <option value="">Choose a launch…</option>
                          {(launches.data ?? [])
                            .filter(
                              (launch) => launch.record.author === myPubkey,
                            )
                            .map((launch) => (
                              <option
                                key={launch.record.id}
                                value={launch.record.id}
                              >
                                {launch.record.name}
                              </option>
                            ))}
                        </select>
                      </PitchField>
                    </div>
                  ) : null}
                </div>

                <PitchField
                  error={errorFor("name")}
                  hint="The name people will see on the project board."
                  id="pitch-name"
                  label="Project name"
                >
                  <Input
                    aria-describedby="pitch-name-feedback"
                    aria-invalid={Boolean(errorFor("name")) || undefined}
                    className="h-10 bg-background/60"
                    id="pitch-name"
                    maxLength={MAX_NAME_LEN}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Nebula"
                    value={name}
                  />
                </PitchField>
                <PitchField
                  error={errorFor("summary")}
                  hint={`${summary.length}/${MAX_SUMMARY_LEN} · The idea in one sentence.`}
                  id="pitch-summary"
                  label="One-line pitch"
                >
                  <Input
                    aria-describedby="pitch-summary-feedback"
                    aria-invalid={Boolean(errorFor("summary")) || undefined}
                    className="h-10 bg-background/60"
                    id="pitch-summary"
                    maxLength={MAX_SUMMARY_LEN}
                    onChange={(event) => setSummary(event.target.value)}
                    placeholder="A social app for stargazers."
                    value={summary}
                  />
                </PitchField>
                <PitchField
                  error={errorFor("description")}
                  hint={`${description.length}/${MAX_DESCRIPTION_LEN} · Optional. Give future teammates a little more context.`}
                  id="pitch-description"
                  label="Description"
                >
                  <textarea
                    aria-describedby="pitch-description-feedback"
                    aria-invalid={Boolean(errorFor("description")) || undefined}
                    className="min-h-24 w-full resize-y rounded-md border border-input bg-background/60 px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    id="pitch-description"
                    maxLength={MAX_DESCRIPTION_LEN}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What problem are you solving, and what do you want to make together?"
                    rows={3}
                    value={description}
                  />
                </PitchField>
                {mode === "new" ? (
                  <details
                    className="rounded-xl border border-border/60 px-3 py-2"
                    onToggle={(event) =>
                      setAddressOpen(event.currentTarget.open)
                    }
                    open={addressOpen}
                  >
                    <summary className="cursor-pointer text-xs font-medium">
                      Customize page address
                    </summary>
                    <div className="mt-3 pb-1">
                      <PitchField
                        error={errorFor("nodeId")}
                        hint="Suggested from the name. Choose carefully: this address stays with the project."
                        id="pitch-id"
                        label="Page address"
                      >
                        <Input
                          aria-describedby="pitch-id-feedback"
                          aria-invalid={
                            Boolean(errorFor("nodeId")) || undefined
                          }
                          className="h-10 bg-background/60 font-mono"
                          id="pitch-id"
                          onChange={(event) => {
                            setIdTouched(true);
                            setNodeId(event.target.value);
                          }}
                          value={derivedId}
                        />
                      </PitchField>
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <>
                <div className="rounded-xl border border-border/60 bg-foreground/[0.04] px-3 py-2.5">
                  <p className="break-words text-sm font-semibold">{name}</p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {summary}
                  </p>
                </div>
                {roleError ? (
                  <p
                    className="text-xs text-red-600 dark:text-red-400"
                    data-testid="pitch-roles-error"
                    id="pitch-roles-error"
                    role="alert"
                  >
                    {roleError}
                  </p>
                ) : null}
                <div className="rounded-xl border border-border/60 p-3">
                  <RoleRowInputs
                    index={0}
                    invalid={Boolean(roleError)}
                    onChange={setMyRole}
                    row={myRole}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    The role you take as the founder and your proposed stake.
                  </p>
                </div>
                <section
                  aria-labelledby="pitch-open-roles"
                  className="rounded-xl border border-border/60 p-3"
                >
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold" id="pitch-open-roles">
                      Open roles
                    </h3>
                    {openRoles.length < MAX_ROLES - 1 ? (
                      <Button
                        className="h-8"
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
                        <Plus aria-hidden className="mr-1 h-3 w-3" /> Add a role
                      </Button>
                    ) : null}
                  </div>
                  <div className="space-y-3">
                    {openRoles.map((role, index) => (
                      <RoleRowInputs
                        index={index + 1}
                        invalid={Boolean(roleError)}
                        key={role.uid}
                        onChange={(next) =>
                          setOpenRoles((current) =>
                            current.map((row) =>
                              row.uid === role.uid ? next : row,
                            ),
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
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {openRoles.length
                      ? "People can request a role at its proposed stake. You approve who joins."
                      : "You can pitch solo. Add a role when you know who you need."}
                  </p>
                </section>
                <StakeSummary founder={myRole} openRoles={openRoles} />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Stakes are declarations, and a recorded role is a record the
                  founder can take back: not Shares and not a legal contract. If
                  the project starts as a contributor project, each role becomes
                  a work area whose Shares are awarded by vote for reviewed
                  work.
                </p>
              </>
            )}
          </fieldset>

          {partial ? (
            <div
              className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              data-testid="pitch-partial-error"
              ref={publishErrorRef}
              role="alert"
            >
              <p className="flex items-start gap-2">
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  Your project was created, but the pitch didn't send, so it
                  isn't on the board yet.{" "}
                  <span className="text-muted-foreground">
                    {partial.reason}
                  </span>
                </span>
              </p>
              <TechnicalDetails
                className="mt-1"
                detail={partial.detail}
                testId="pitch-partial-error-details"
              />
              <Button
                className="mt-2"
                disabled={create.isPending}
                onClick={() =>
                  lastInput && publish({ ...lastInput, skipNode: true })
                }
                size="sm"
                type="button"
              >
                Retry the pitch
              </Button>
            </div>
          ) : publishError ? (
            <div
              className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
              data-testid="pitch-error"
              ref={publishErrorRef}
            >
              <SignRecovery
                message={publishError.message}
                messageTestId="pitch-error-message"
                onUnlocked={() => lastInput && publish(lastInput)}
                testId="pitch-sign-recovery"
              />
              <TechnicalDetails
                className="mt-1"
                detail={
                  publishError instanceof PitchPublishError
                    ? publishError.detail
                    : null
                }
                testId="pitch-error-details"
              />
            </div>
          ) : null}
        </section>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 pt-4">
          <Button
            disabled={create.isPending}
            onClick={
              step === "project"
                ? close
                : () => {
                    setFieldError(null);
                    setStep("project");
                  }
            }
            type="button"
            variant="ghost"
          >
            {step === "project" ? "Cancel" : "Back"}
          </Button>
          <Button disabled={create.isPending || sourceMissing} type="submit">
            {create.isPending
              ? "Publishing…"
              : step === "project"
                ? "Continue"
                : "Publish pitch"}
            {step === "project" ? (
              <ArrowRight aria-hidden className="ml-1.5 h-4 w-4" />
            ) : null}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
