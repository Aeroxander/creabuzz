/**
 * Project detail — the team map, the join and approval flows, and the handoff
 * to the launchpad.
 *
 * Paperclip stance: every section says what is happening (the map and the
 * request list), whether it needs the founder (Approve/Decline right on the
 * row, with the refusal reason inline instead of a disabled button), and what
 * to do about it (one CTA per open role, one bridge to the DAO flow).
 *
 * Honesty rules baked into this page:
 * - the stake disclaimer is always visible next to the map;
 * - a founder stake is labelled `declared`, a joiner stake `recorded` — the
 *   two provenance tiers never blur;
 * - approvals and declines publish one event each, so a relay refusal shows
 *   on the row that caused it, not as a generic toast;
 * - a missing org node (the thing grants point at) is called out instead of
 *   quietly rendering grants that a strict relay would refuse.
 */

import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey, userPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { errorMessage, QueryError } from "@/shared/ui/query-error";
import { buildDeclineTemplate } from "../lib/join-request";
import { buildOwnershipGrantTemplate } from "../lib/grant";
import { POOL_PCT, type RoleDeclaration } from "../lib/manifest";
import { canApprove, type ProjectState, type RequestState } from "../lib/state";
import {
  PROJECT_EVENT_KINDS,
  useProject,
  usePublishProjectEvent,
} from "../use-projects";
import { JoinDialog, STAKE_DISCLAIMER } from "./JoinDialog";
import { SummonDialog } from "./SummonDialog";

function StatusPill({ status }: { status: RequestState["status"] }) {
  const copy: Record<
    RequestState["status"],
    { label: string; tone: string; testid: string }
  > = {
    approved: {
      label: "Recorded",
      tone: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
      testid: "request-status-approved",
    },
    declined: {
      label: "Declined",
      tone: "bg-black/10 text-black/60 dark:bg-white/15 dark:text-white/60",
      testid: "request-status-declined",
    },
    "role-filled": {
      label: "Role filled",
      tone: "bg-black/10 text-black/60 dark:bg-white/15 dark:text-white/60",
      testid: "request-status-role-filled",
    },
    "role-removed": {
      label: "Role removed",
      tone: "bg-black/10 text-black/60 dark:bg-white/15 dark:text-white/60",
      testid: "request-status-role-removed",
    },
    pending: {
      label: "Waiting on the founder",
      tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
      testid: "request-status-pending",
    },
  };
  const entry = copy[status];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-2xs font-medium ${entry.tone}`}
      data-testid={entry.testid}
    >
      {entry.label}
    </span>
  );
}

function PoolStrip({ project }: { project: ProjectState }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/10 bg-black/[0.02] px-4 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]"
      data-testid="pool-strip"
    >
      <span className="text-black/70 dark:text-white/70">
        <span className="font-semibold text-black dark:text-white">
          {project.grantedPct}%
        </span>{" "}
        recorded ·{" "}
        <span className="font-semibold text-black dark:text-white">
          {project.declaredPct}%
        </span>{" "}
        declared ·{" "}
        <span className="font-semibold text-black dark:text-white">
          {project.remainingPct}%
        </span>{" "}
        of the {POOL_PCT}% pool still unrecorded
      </span>
      <span
        className="text-xs text-black/50 dark:text-white/50"
        data-testid="stake-disclaimer"
      >
        {STAKE_DISCLAIMER}
      </span>
    </div>
  );
}

function TeamMap({
  project,
  nameOf,
}: {
  project: ProjectState;
  nameOf: (pubkey: string) => string;
}) {
  return (
    <Card className="p-4" data-testid="team-map">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Team map</h2>
        <span className="text-2xs text-black/50 dark:text-white/50">
          {project.team.length} of {project.roles.length} roles placed
        </span>
      </div>
      <ul className="mt-3 flex flex-col divide-y divide-black/5 dark:divide-white/5">
        {project.team.map((member) => (
          <li
            className="flex items-center justify-between gap-3 py-2"
            key={`${member.pubkey}-${member.role.slug}`}
          >
            <span className="min-w-0">
              <span
                className="block truncate text-sm font-medium"
                title={member.pubkey}
              >
                {nameOf(member.pubkey)}
              </span>
              <span className="block text-2xs text-black/50 dark:text-white/50">
                {member.role.label}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-semibold tabular-nums">
                {member.pct}%
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                  member.source === "grant"
                    ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                    : "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50"
                }`}
                data-testid={`team-source-${member.source}`}
                title={
                  member.source === "grant"
                    ? "Recorded by an ownership grant the founder published"
                    : "Declared by the founder's pitch, not yet a grant"
                }
              >
                {member.source === "grant" ? "recorded" : "declared"}
              </span>
            </span>
          </li>
        ))}
        {project.team.length === 0 ? (
          <li className="py-3 text-sm text-black/50 dark:text-white/50">
            Nothing recorded yet — the founder's stake appears once the pitch
            declares it.
          </li>
        ) : null}
      </ul>
      <p className="mt-3 text-2xs text-black/50 dark:text-white/50">
        <span className="font-medium">recorded</span> = an ownership grant the
        founder published · <span className="font-medium">declared</span> = the
        founder's stake asserted by the pitch. Both stay revocable until the DAO
        adopts the map.
      </p>
    </Card>
  );
}

function RequestRow({
  state,
  isFounder,
  busyKey,
  rowError,
  onApprove,
  onDecline,
  nameOf,
}: {
  state: RequestState;
  isFounder: boolean;
  busyKey: string | null;
  rowError: { key: string; message: string } | null;
  onApprove: (state: RequestState) => void;
  onDecline: (state: RequestState) => void;
  nameOf: (pubkey: string) => string;
}) {
  const busy = busyKey === state.request.key;
  const error = rowError?.key === state.request.key ? rowError.message : null;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid="request-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span
            className="block truncate text-sm font-medium"
            title={state.request.requester}
          >
            {nameOf(state.request.requester)}
          </span>
          <span className="text-2xs text-black/50 dark:text-white/50">
            {state.role?.label ?? state.request.role} · asks{" "}
            <span className="font-semibold">{state.request.pct}%</span>
          </span>
        </span>
        <StatusPill status={state.status} />
      </div>
      {state.request.note ? (
        <p className="text-sm text-black/60 dark:text-white/60">
          “{state.request.note}”
        </p>
      ) : null}
      {isFounder && state.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy}
            onClick={() => onApprove(state)}
            size="sm"
            type="button"
          >
            <Check className="mr-1 h-3 w-3" aria-hidden />
            {busy ? "Recording…" : `Approve ${state.request.pct}%`}
          </Button>
          <Button
            disabled={busy}
            onClick={() => onDecline(state)}
            size="sm"
            type="button"
            variant="outline"
          >
            <X className="mr-1 h-3 w-3" aria-hidden /> Decline
          </Button>
        </div>
      ) : null}
      {error ? (
        <SignRecovery
          className="text-xs"
          message={error}
          messageTestId="request-error"
          testId="request-sign-recovery"
        />
      ) : null}
    </li>
  );
}

function LaunchpadBridge({
  isFounder,
  nameOf,
  project,
  projectId,
}: {
  isFounder: boolean;
  nameOf: (pubkey: string) => string;
  project: ProjectState;
  projectId: string;
}) {
  const launches = useLaunches();
  const launch = launches.data?.find(
    (record) => record.record.id === projectId,
  );
  const [summonOpen, setSummonOpen] = useState(false);
  const linkClass =
    "inline-flex w-fit items-center gap-1 rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 dark:bg-white dark:text-black";
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="dao-bridge">
      <div>
        <h2 className="text-base font-semibold">Form the DAO</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          This map — recorded grants plus the founder's declared stake — is what
          seeds your TGE allocation. The launchpad holds it inside the budget
          envelope: a monthly budget of at most{" "}
          <span className="font-medium text-black dark:text-white">
            1/6 of the graduation threshold
          </span>{" "}
          (the minimum raise), with large spends default-passing only up to{" "}
          <span className="font-medium text-black dark:text-white">
            3× that budget
          </span>
          . Forming the DAO is what turns a revocable record into an enforceable
          one.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {isFounder ? (
          <Button
            className={linkClass}
            data-testid="form-dao"
            onClick={() => setSummonOpen(true)}
            type="button"
          >
            Form the DAO
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        ) : (
          <p className="text-2xs text-black/50 dark:text-white/50">
            The founder forms the DAO from this map.
          </p>
        )}
        {launch ? (
          <Link
            className={linkClass}
            data-testid="dao-bridge-link"
            params={{ launchId: projectId }}
            search={{ action: undefined, author: launch.record.author }}
            to="/launchpad/$launchId"
          >
            Open this project's launch
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : (
          <Link
            className={linkClass}
            data-testid="dao-bridge-link"
            search={{ action: undefined, author: undefined }}
            to="/launchpad"
          >
            Open the launchpad
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        )}
      </div>
      <p className="text-2xs text-black/50 dark:text-white/50">
        {launch
          ? "A launch record already exists for this project id."
          : `No launch record for “${projectId}” yet — start one there; the ids line up.`}
      </p>
      {summonOpen ? (
        <SummonDialog
          launch={launch}
          nameOf={nameOf}
          onOpenChange={setSummonOpen}
          project={project}
        />
      ) : null}
    </Card>
  );
}

export function ProjectDetailPage({
  projectId,
  author,
  action,
}: {
  projectId: string;
  author?: string;
  /** `?action=join` from the Discover directory: open the join dialog. */
  action?: "join";
}) {
  const { project, hasNode, isLoading, error, refetch } = useProject(
    projectId,
    author,
  );
  const publish = usePublishProjectEvent();
  const me = existingUserPubkey();
  const [joinRole, setJoinRole] = useState<RoleDeclaration | null>(null);

  // Directory handoff: `?action=join` opens the join dialog for the first
  // open role, exactly as clicking "Request to join" on a card would — the
  // dialog itself is not rebuilt here. Latched so closing it cannot re-open
  // it, and never for the founder, who has nothing to request.
  const joinDeepLinkTried = useRef(false);
  useEffect(() => {
    if (action !== "join" || !project || joinDeepLinkTried.current) return;
    joinDeepLinkTried.current = true;
    if (project.founder === me) return;
    const first = project.roles.find((roleState) => roleState.open);
    if (first) setJoinRole(first.role);
  }, [action, me, project]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    key: string;
    message: string;
  } | null>(null);

  const nameOf = useUserNames(
    project
      ? [
          project.founder,
          ...project.team.map((member) => member.pubkey),
          ...project.requests.map((state) => state.request.requester),
        ]
      : [],
  );

  function act(state: RequestState, action: "approve" | "decline") {
    if (!project) return;
    setRowError(null);
    if (action === "approve") {
      const check = canApprove(project, state.request);
      if (!check.ok) {
        setRowError({ key: state.request.key, message: check.reason });
        return;
      }
    }
    setBusyKey(state.request.key);
    const template =
      action === "approve"
        ? buildOwnershipGrantTemplate({
            nodeId: project.manifest.nodeId,
            role: state.request.role,
            pct: state.request.pct,
            grantee: state.request.requester,
            issuer: userPubkey(),
          })
        : buildDeclineTemplate(state.request);
    publish.mutate(template, {
      onError: (err) => {
        setBusyKey(null);
        setRowError({
          key: state.request.key,
          message:
            err instanceof Error
              ? err.message
              : "The relay rejected this event.",
        });
      },
      onSuccess: () => setBusyKey(null),
    });
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <p className="text-sm text-black/60 dark:text-white/60">
          Loading project…
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <QueryError
          description="The relay did not answer the project query, so this page cannot show a team map."
          error={error}
          kinds={PROJECT_EVENT_KINDS}
          message={errorMessage(error)}
          onRetry={refetch}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="project-load-error"
          title="Couldn't load this project"
        />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Link
          className="inline-flex items-center gap-1 text-sm text-black/60 hover:underline dark:text-white/60"
          to="/projects"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> All projects
        </Link>
        <div
          className="mt-4 rounded-2xl border border-dashed border-black/15 px-5 py-10 text-center dark:border-white/15"
          data-testid="project-empty"
        >
          <p className="text-sm text-black/60 dark:text-white/60">
            No pitch on this relay for <code>{projectId}</code>
            {author ? "" : " under any author"}. If it was just published, the
            query may not have it yet.
          </p>
          <Button className="mt-4" onClick={refetch} size="sm" type="button">
            Check again
          </Button>
        </div>
      </div>
    );
  }

  const isFounder = me !== null && me === project.founder;
  const openRoles = project.roles.filter((roleState) => roleState.open);
  const myRequests = project.requests.filter(
    (state) => state.request.requester === me,
  );
  const pendingRequests = project.requests.filter(
    (state) => state.status === "pending",
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">
      <Link
        className="inline-flex w-fit items-center gap-1 text-sm text-black/60 hover:underline dark:text-white/60"
        to="/projects"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> All projects
      </Link>

      <PageHeader
        description={project.manifest.summary}
        title={project.manifest.name}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-black/50 dark:text-white/50">
        <span title={project.founder}>{nameOf(project.founder)} · founder</span>
        <span>Updated {relativeTime(project.manifest.createdAt)}</span>
        <span>
          ID{" "}
          <code className="font-mono text-xs">{project.manifest.nodeId}</code>
        </span>
      </div>

      {!hasNode ? (
        <div
          className="flex items-start gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
          data-testid="missing-node"
          role="status"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            This project's org node hasn't reached the relay yet. Approvals
            publish ownership grants that point at that node — relays with
            grant-chain enforcement will hold them until it lands.
          </span>
        </div>
      ) : null}

      <PoolStrip project={project} />

      <TeamMap nameOf={nameOf} project={project} />

      <Card className="p-4" data-testid="open-roles">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Open roles</h2>
          <span className="text-2xs text-black/50 dark:text-white/50">
            {openRoles.length} open
          </span>
        </div>
        {openRoles.length === 0 ? (
          <p className="mt-2 text-sm text-black/50 dark:text-white/50">
            Nothing to ask for: every declared role is taken by the founder or
            recorded to someone.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-black/5 dark:divide-white/5">
            {openRoles.map((roleState) => {
              const mine = myRequests.find(
                (state) => state.request.role === roleState.role.slug,
              );
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                  key={roleState.role.slug}
                  data-testid={`open-role-${roleState.role.slug}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {roleState.role.label}
                    </span>
                    <span className="text-2xs text-black/50 dark:text-white/50">
                      targets {roleState.role.pct}% · id{" "}
                      <code className="font-mono">{roleState.role.slug}</code>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {mine ? <StatusPill status={mine.status} /> : null}
                    {isFounder ? (
                      <span className="text-2xs text-black/50 dark:text-white/50">
                        open · you're the founder
                      </span>
                    ) : (
                      <Button
                        onClick={() => setJoinRole(roleState.role)}
                        size="sm"
                        type="button"
                      >
                        {mine ? "Update your request" : "Request to join"}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {project.manifest.description ? (
          <p className="mt-4 whitespace-pre-wrap text-sm text-black/60 dark:text-white/60">
            {project.manifest.description}
          </p>
        ) : null}
      </Card>

      {myRequests.length > 0 ? (
        <Card className="p-4" data-testid="my-requests">
          <h2 className="text-base font-semibold">Your requests</h2>
          <ul className="mt-1 divide-y divide-black/5 dark:divide-white/5">
            {myRequests.map((state) => (
              <RequestRow
                busyKey={busyKey}
                isFounder={false}
                key={state.request.eventId}
                nameOf={nameOf}
                onApprove={() => undefined}
                onDecline={() => undefined}
                rowError={rowError}
                state={state}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      {isFounder ? (
        <Card className="p-4" data-testid="founder-requests">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Requests needing you</h2>
            <span className="text-2xs text-black/50 dark:text-white/50">
              {pendingRequests.length} waiting
            </span>
          </div>
          <p className="mt-1 text-xs text-black/50 dark:text-white/50">
            Approving publishes one ownership grant — the % becomes a recorded,
            revocable stake. Declining records the decision on the request's
            thread. Nothing here is a contract.
          </p>
          {pendingRequests.length === 0 ? (
            <p className="mt-3 text-sm text-black/50 dark:text-white/50">
              No open requests. Roles stay open on the board until someone asks.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-black/5 dark:divide-white/5">
              {pendingRequests.map((state) => (
                <RequestRow
                  busyKey={busyKey}
                  isFounder
                  key={state.request.eventId}
                  nameOf={nameOf}
                  onApprove={(row) => act(row, "approve")}
                  onDecline={(row) => act(row, "decline")}
                  rowError={rowError}
                  state={state}
                />
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <LaunchpadBridge
        isFounder={isFounder}
        nameOf={nameOf}
        project={project}
        projectId={projectId}
      />

      {joinRole ? (
        <JoinDialog
          onOpenChange={(next) => {
            if (!next) setJoinRole(null);
          }}
          open
          project={project}
          role={joinRole}
        />
      ) : null}
    </div>
  );
}
