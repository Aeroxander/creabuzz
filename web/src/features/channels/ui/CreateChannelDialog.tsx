/**
 * Create-channel dialog: name, topic, visibility, template, and the
 * agents/teams that join the channel. Mirrors desktop's
 * `CreateChannelDialog` + `useCreateChannelForm` behavior (template prefill
 * with visibility-untouched tracking) using the web client's own event
 * builders and agent roster.
 */

import * as React from "react";

import { useAgentRoster } from "@/features/fleet/use-agent-roster";
import { notContributorOnlyBuild } from "@/app/lib/build-gates";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { FailureNote } from "@/shared/ui/failure-note";

import {
  CHANNEL_TEMPLATES,
  getChannelTemplate,
  groupAgentsByTeam,
  planTemplateAttachments,
  type RosterAgent,
} from "../lib/channel-templates";
import type {
  ChannelTypeChoice,
  ChannelVisibilityChoice,
} from "../lib/channel-create-events";
import {
  type AttachFailure,
  type ChannelMemberInput,
  useAttachChannelMembers,
  useCreateChannel,
} from "../use-create-channel";

const FORM_ID = "create-channel-form";

function toRosterAgents(
  agents: ReturnType<typeof useAgentRoster>["agents"],
): RosterAgent[] {
  return agents.map((a) => ({
    id: a.id,
    pubkey: a.pubkey,
    name: a.name,
    team: a.team,
  }));
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  defaultType = "stream",
  defaultVisibility = "open",
  defaultName = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the dialog starts on: a live chat, or a board of posts and replies. */
  defaultType?: ChannelTypeChoice;
  defaultVisibility?: ChannelVisibilityChoice;
  defaultName?: string;
}) {
  const roster = useAgentRoster();
  const agents = React.useMemo(
    () => toRosterAgents(roster.agents),
    [roster.agents],
  );
  const teams = React.useMemo(() => groupAgentsByTeam(agents), [agents]);

  const [name, setName] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [visibility, setVisibility] =
    React.useState<ChannelVisibilityChoice>(defaultVisibility);
  const [channelType, setChannelType] =
    React.useState<ChannelTypeChoice>(defaultType);
  const [templateId, setTemplateId] = React.useState("blank");
  const [teamName, setTeamName] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [formError, setFormError] = React.useState<FailureWords | null>(null);
  const [pendingMembers, setPendingMembers] = React.useState<
    AttachFailure[] | null
  >(null);
  const [createdChannelId, setCreatedChannelId] = React.useState<string | null>(
    null,
  );
  const [unresolvedSeats, setUnresolvedSeats] = React.useState<string[]>([]);
  const visibilityTouchedRef = React.useRef(false);
  const topicTouchedRef = React.useRef(false);

  const createMutation = useCreateChannel();
  const attachMutation = useAttachChannelMembers();
  const isCreating = createMutation.isPending;

  // Reset the form every time the dialog opens (desktop's `active` behavior).
  React.useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setTopic("");
    setVisibility(defaultVisibility);
    setChannelType(defaultType);
    setTemplateId("blank");
    setTeamName("");
    setSelected(new Set());
    setFormError(null);
    setPendingMembers(null);
    setCreatedChannelId(null);
    setUnresolvedSeats([]);
    visibilityTouchedRef.current = false;
    topicTouchedRef.current = false;
    createMutation.reset();
    attachMutation.reset();
  }, [
    open,
    defaultType,
    defaultVisibility,
    defaultName,
    createMutation.reset,
    attachMutation.reset,
  ]);

  const applyTemplate = React.useCallback(
    (id: string) => {
      const template = getChannelTemplate(id);
      if (!template) return;
      setTemplateId(id);
      if (!topicTouchedRef.current) setTopic(template.topic);
      if (!visibilityTouchedRef.current) setVisibility(template.visibility);
      setChannelType(template.channelType);
      if (template.seats.some((s) => s.type === "team" && !s.teamName)) {
        const firstTeam = [...teams.keys()].find((t) => t !== "");
        setTeamName((current) => current || firstTeam || "");
      }
    },
    [teams],
  );

  // Resolve the template's seats into checkboxes whenever the inputs change.
  React.useEffect(() => {
    const template = getChannelTemplate(templateId);
    if (!template || template.seats.length === 0) {
      setUnresolvedSeats([]);
      return;
    }
    const { attachments, unresolvedSeats: misses } = planTemplateAttachments(
      template,
      agents,
      { preferredTeamName: teamName },
    );
    setUnresolvedSeats(misses);
    setSelected((current) => {
      // Only seed when the user hasn't picked anyone yet for this template.
      if (current.size > 0) return current;
      return new Set(attachments.map((a) => a.pubkey));
    });
  }, [agents, teamName, templateId]);

  const members: ChannelMemberInput[] = React.useMemo(() => {
    return agents
      .filter((a) => selected.has(a.pubkey.toLowerCase()))
      .map((a) => ({ pubkey: a.pubkey, name: a.name, role: "bot" }));
  }, [agents, selected]);

  const toggleAgent = (pubkey: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = pubkey.toLowerCase();
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleTeam = (team: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const agent of teams.get(team) ?? []) {
        const key = agent.pubkey.toLowerCase();
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isCreating) return;
    setFormError(null);
    createMutation.mutate(
      {
        name: trimmed,
        topic: topic.trim() || undefined,
        visibility,
        channelType,
        members,
      },
      {
        onSuccess: (result) => {
          setCreatedChannelId(result.channelId);
          setPendingMembers(result.attachFailures);
          if (result.attachFailures.length === 0) {
            onOpenChange(false);
          }
        },
        onError: (error) => {
          setFormError(
            failureWords(error, "Couldn't create the room. Try again."),
          );
        },
      },
    );
  }

  function retryPendingMembers() {
    if (!createdChannelId || !pendingMembers || pendingMembers.length === 0) {
      return;
    }
    attachMutation.mutate(
      { channelId: createdChannelId, members: pendingMembers },
      {
        onSuccess: (result) => setPendingMembers(result.attachFailures),
      },
    );
  }

  const template = getChannelTemplate(templateId);
  const teamSeatNeeded = Boolean(
    template?.seats.some((s) => s.type === "team"),
  );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent
        className="max-w-lg"
        data-testid="create-channel-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {channelType === "forum" ? "Create a board" : "Create a room"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {channelType === "forum"
              ? "A board is where people post topics and reply under them. It stays easy to find later. You can add AI helpers and teams now or later."
              : "Rooms are where your community talks. You can add AI helpers and teams now or later."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form className="space-y-4" id={FORM_ID} onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="channel-name">
              Name
            </label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFormError(null);
              }}
              placeholder="e.g. design"
              autoComplete="off"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="channel-topic">
              Topic
            </label>
            <Input
              id="channel-topic"
              value={topic}
              onChange={(e) => {
                topicTouchedRef.current = true;
                setTopic(e.target.value);
              }}
              placeholder="What this room is about"
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="channel-visibility"
              >
                Who can find it
              </label>
              <select
                id="channel-visibility"
                className="h-9 w-full rounded-md border border-black/15 bg-white px-2 text-sm dark:border-white/15 dark:bg-white/5"
                value={visibility}
                onChange={(e) => {
                  visibilityTouchedRef.current = true;
                  setVisibility(e.target.value as ChannelVisibilityChoice);
                }}
              >
                <option value="open">Anyone in the community</option>
                <option value="private">Only people I add</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="channel-type">
                Layout
              </label>
              <select
                id="channel-type"
                className="h-9 w-full rounded-md border border-black/15 bg-white px-2 text-sm dark:border-white/15 dark:bg-white/5"
                value={channelType}
                onChange={(e) =>
                  setChannelType(e.target.value as ChannelTypeChoice)
                }
              >
                <option value="stream">Live chat</option>
                <option value="forum">Board (posts and replies)</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="channel-template">
              Template
            </label>
            <select
              id="channel-template"
              className="h-9 w-full rounded-md border border-black/15 bg-white px-2 text-sm dark:border-white/15 dark:bg-white/5"
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              aria-describedby="channel-template-summary"
            >
              {CHANNEL_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p
              id="channel-template-summary"
              className="text-xs text-black/60 dark:text-white/60"
            >
              {template?.summary}
            </p>
            {teamSeatNeeded && (
              <div className="space-y-1.5 pt-1">
                <label className="text-sm font-medium" htmlFor="channel-team">
                  Team
                </label>
                <select
                  id="channel-team"
                  className="h-9 w-full rounded-md border border-black/15 bg-white px-2 text-sm dark:border-white/15 dark:bg-white/5"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                >
                  {[...teams.keys()].filter((t) => t !== "").length === 0 ? (
                    <option value="">No teams found</option>
                  ) : (
                    [...teams.keys()]
                      .filter((t) => t !== "")
                      .map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))
                  )}
                </select>
              </div>
            )}
          </div>

          {/* AI helpers need an AI service a contributor-only build's server does not run: no picker for them there. */}
          {notContributorOnlyBuild() ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who joins</legend>
              <p className="text-xs text-black/60 dark:text-white/60">
                AI helpers join as members. You can add or remove them later.
              </p>
              {roster.loading ? (
                <p className="text-xs text-black/60 dark:text-white/60">
                  Loading AI helpers…
                </p>
              ) : roster.loadError != null ? (
                <p
                  className="text-xs text-amber-700 dark:text-amber-300"
                  role="alert"
                >
                  Couldn't load the AI helpers. You can still create the room
                  and add them later.
                </p>
              ) : agents.length === 0 ? (
                <p className="text-xs text-black/60 dark:text-white/60">
                  No AI helpers in this community yet.
                </p>
              ) : (
                <div className="max-h-48 space-y-2 overflow-y-auto">
                  {[...teams.entries()].map(([team, teamAgents]) => {
                    const teamKey = team || "";
                    const allOn = teamAgents.every((a) =>
                      selected.has(a.pubkey.toLowerCase()),
                    );
                    return (
                      <div key={teamKey || "unassigned"} className="space-y-1">
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="checkbox"
                            checked={allOn}
                            onChange={(e) =>
                              toggleTeam(teamKey, e.target.checked)
                            }
                          />
                          {team || "Not on a team"}
                          <span className="text-xs text-black/50 dark:text-white/50">
                            {teamAgents.length}{" "}
                            {teamAgents.length === 1
                              ? "AI helper"
                              : "AI helpers"}
                          </span>
                        </label>
                        <div className="ml-6 space-y-0.5">
                          {teamAgents.map((agent) => {
                            const key = agent.pubkey.toLowerCase();
                            return (
                              <label
                                key={agent.id}
                                className="flex items-center gap-2 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  checked={selected.has(key)}
                                  onChange={(e) =>
                                    toggleAgent(agent.pubkey, e.target.checked)
                                  }
                                />
                                <span className="truncate">{agent.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {unresolvedSeats.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  We couldn't add everyone this template asks for:{" "}
                  {unresolvedSeats.join(", ")}.
                </p>
              )}
            </fieldset>
          ) : null}

          {formError && (
            <FailureNote failure={formError} testId="create-channel-error" />
          )}
          {pendingMembers && pendingMembers.length > 0 && (
            <div
              className="space-y-1 text-sm text-amber-700 dark:text-amber-300"
              role="alert"
            >
              <p>
                Room created, but {pendingMembers.length}{" "}
                {pendingMembers.length === 1 ? "member" : "members"} couldn't be
                added:{" "}
                {pendingMembers.map((m: AttachFailure) => m.name).join(", ")}.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={retryPendingMembers}
                disabled={attachMutation.isPending}
                data-testid="retry-member-attach"
              >
                {attachMutation.isPending ? "Adding…" : "Add them again"}
              </Button>
            </div>
          )}
        </form>

        <AlertDialogFooter className="sm:items-center">
          {/* Why the button is not ready yet, beside it. */}
          {name.trim().length === 0 && !isCreating ? (
            <p
              className="text-xs text-black/60 sm:mr-auto dark:text-white/60"
              data-testid="create-channel-why"
              id="create-channel-why"
            >
              Give it a name first.
            </p>
          ) : null}
          <AlertDialogCancel disabled={isCreating}>
            {pendingMembers && pendingMembers.length > 0 ? "Done" : "Cancel"}
          </AlertDialogCancel>
          <Button
            type="submit"
            form={FORM_ID}
            aria-describedby={
              name.trim().length === 0 && !isCreating
                ? "create-channel-why"
                : undefined
            }
            disabled={name.trim().length === 0 || isCreating}
            data-testid="submit-create-channel"
          >
            {isCreating
              ? "Creating…"
              : channelType === "forum"
                ? "Create board"
                : "Create room"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
