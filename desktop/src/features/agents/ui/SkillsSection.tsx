import * as React from "react";
import { Plus } from "lucide-react";

import { AddSkillDialog } from "@/features/agents/ui/AddSkillDialog";
import { AgentSkillsDialog } from "@/features/agents/ui/AgentSkillsDialog";
import {
  agentsBoundToSkill,
  bindingNotice,
  clearNotice,
  deriveSkillLibraryState,
  scopeLabel,
  shortSha,
  skillBindingCapWarning,
  skillsById,
  type AgentSkillBindings,
  type SkillBindingChange,
  type SkillScope,
} from "@/features/agents/lib/skillLibrary";
import {
  useSkillLibraryMutations,
  useSkillLibraryQueries,
  type PublishSkillInput,
} from "@/features/agents/lib/useSkillLibrary";
import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";

function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

type LibraryNotice = { tone: "notice" | "error"; text: string };

/**
 * The project skill library: what skills exist, who is bound to each, and the
 * one-click bind/unbind editor per agent.
 *
 * Every state is honest about its source: a relay failure renders as an error
 * (never as "no skills"), an unreadable agent renders its bindings as unknown
 * (never as empty), and a failed edit is reported next to the bindings it did
 * not change.
 */
export function SkillsSection() {
  const { skillsQuery, bindingsQuery } = useSkillLibraryQueries();
  const { publishSkillMutation, setBindingMutation } =
    useSkillLibraryMutations();
  const [notice, setNotice] = React.useState<LibraryNotice | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [managedAgent, setManagedAgent] =
    React.useState<AgentSkillBindings | null>(null);

  const skills = skillsQuery.data ?? [];
  const agents = bindingsQuery.data ?? [];
  const skillsError = errorText(skillsQuery.error);
  const bindingsError = errorText(bindingsQuery.error);
  const state = deriveSkillLibraryState({
    isLoading: skillsQuery.isLoading || bindingsQuery.isLoading,
    skillsError,
    bindingsError,
    skills,
  });
  const byId = skillsById(skills);

  async function publishSkill(input: PublishSkillInput) {
    setNotice(null);
    try {
      const skill = await publishSkillMutation.mutateAsync(input);
      setAddOpen(false);
      setNotice({
        tone: "notice",
        text: `Published '${skill.name}' to this project's skill library.`,
      });
    } catch {
      // The mutation's error is rendered inline by the dialog — a publish
      // failure is never folded into a success notice.
    }
  }

  async function applyChange(change: SkillBindingChange) {
    if (!managedAgent) return;
    setNotice(null);
    try {
      const result = await setBindingMutation.mutateAsync({
        personaId: managedAgent.personaId,
        change,
      });
      const skillName =
        change.type === "clear"
          ? null
          : (byId.get(change.skillId)?.name ?? change.skillId);
      const text =
        change.type === "clear"
          ? clearNotice(managedAgent.displayName, result)
          : bindingNotice(
              change,
              managedAgent.displayName,
              skillName ?? change.skillId,
              result,
            );
      setNotice({ tone: "notice", text });
    } catch (error) {
      // Nothing was invalidated: the binding list still shows the durable
      // state, and this message says the edit failed.
      setNotice({
        tone: "error",
        text: `${errorText(error) ?? "The binding change failed."} ${managedAgent.displayName}'s bindings were not changed.`,
      });
    }
  }

  return (
    <section className="space-y-4" data-testid="agents-library-skills">
      <SectionHeader
        action={
          <Button
            data-testid="add-skill-button"
            onClick={() => {
              setNotice(null);
              setAddOpen(true);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus />
            Add skill
          </Button>
        }
        description="Instruction sets bound to your agents. A bound skill is injected into the agent's next session."
        title="Project skills"
      />

      {state === "loading" ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading this project&apos;s skills…
        </p>
      ) : null}

      {state === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive">
            Couldn&apos;t load the skill library: {skillsError ?? bindingsError}
          </p>
          <Button
            onClick={() => {
              void skillsQuery.refetch();
              void bindingsQuery.refetch();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : null}

      {state === "empty" ? (
        <div className="space-y-3 rounded-lg border border-dashed p-6">
          <p className="text-sm text-muted-foreground">
            No skills yet. Add one from a catalog URL (for example
            https://ethskills.com/SKILL.md) or paste a SKILL.md.
          </p>
          <Button
            onClick={() => setAddOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus />
            Add skill
          </Button>
        </div>
      ) : null}

      {state === "ready" ? (
        <div className="space-y-6">
          {notice && !managedAgent ? (
            <p
              className={
                notice.tone === "error"
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
              role={notice.tone === "error" ? "alert" : "status"}
            >
              {notice.text}
            </p>
          ) : null}

          <ul aria-label="Skills" className="space-y-3">
            {skills.map((skill) => {
              const bound = agentsBoundToSkill(skill.id, agents);
              return (
                <li
                  className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4"
                  data-testid={`skill-row-${skill.id}`}
                  key={skill.eventId}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="text-sm font-semibold">{skill.name}</h3>
                    <p className="text-sm text-muted-foreground">
                      {skill.description}
                    </p>
                    <p className="text-2xs text-muted-foreground">
                      {shortSha(skill.sha256)} · applies to{" "}
                      {scopeLabel(skill.appliesTo ?? "all")}
                      {skill.source ? ` · source: ${skill.source}` : ""}
                    </p>
                  </div>
                  <div className="flex max-w-full flex-wrap gap-1.5">
                    {bound.length === 0 ? (
                      <span className="text-2xs text-muted-foreground">
                        Not bound
                      </span>
                    ) : (
                      bound.map((agent) => {
                        const scope =
                          agent.bindings.find(
                            (binding) => binding.skillId === skill.id,
                          )?.scope ?? "all";
                        return (
                          <span
                            className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground"
                            key={agent.personaId}
                          >
                            {agent.displayName} · {scopeLabel(scope)}
                          </span>
                        );
                      })
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <section className="space-y-3">
            <h3 className="text-sm font-medium">Bindings by agent</h3>
            <ul aria-label="Skill bindings by agent" className="space-y-2">
              {agents
                .filter((agent) => agent.canBind)
                .map((agent) => {
                  const warning = skillBindingCapWarning(agent, skills);
                  return (
                    <li
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                      key={agent.personaId}
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm font-medium">
                          {agent.displayName}
                        </p>
                        {agent.readError ? (
                          <p className="text-2xs text-destructive">
                            Bindings unknown — {agent.readError}
                          </p>
                        ) : (
                          <p className="text-2xs text-muted-foreground">
                            {agent.bindings.length} bound skill
                            {agent.bindings.length === 1 ? "" : "s"}
                          </p>
                        )}
                        {warning.message ? (
                          <p
                            className={
                              warning.level === "at"
                                ? "text-2xs text-destructive"
                                : "text-2xs text-muted-foreground"
                            }
                          >
                            {warning.message}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        aria-label={`Manage skills for ${agent.displayName}`}
                        data-testid={`manage-skills-${agent.personaId}`}
                        disabled={Boolean(agent.readError)}
                        onClick={() => {
                          setNotice(null);
                          setManagedAgent(agent);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Manage
                      </Button>
                    </li>
                  );
                })}
            </ul>
          </section>
        </div>
      ) : null}

      <AddSkillDialog
        error={errorText(publishSkillMutation.error)}
        isPending={publishSkillMutation.isPending}
        onOpenChange={setAddOpen}
        onSubmit={(input) => {
          void publishSkill(input);
        }}
        open={addOpen}
      />

      {managedAgent ? (
        <AgentSkillsDialog
          agent={managedAgent}
          error={
            setBindingMutation.isPending
              ? null
              : errorText(setBindingMutation.error)
          }
          isPending={setBindingMutation.isPending}
          onClearAll={() => {
            void applyChange({ type: "clear" });
          }}
          onBind={(skillId: string, scope: SkillScope) => {
            void applyChange({ type: "bind", skillId, scope });
          }}
          onOpenChange={(open) => {
            if (!open) setManagedAgent(null);
          }}
          onUnbind={(skillId: string) => {
            void applyChange({ type: "unbind", skillId });
          }}
          open
          // Settled-edit results render inside the dialog, next to the
          // bindings they describe. Failures stay on `error` — passing them
          // here too would report the same rejection twice.
          notice={notice?.tone === "notice" ? notice.text : null}
          skills={skills}
        />
      ) : null}
    </section>
  );
}
