import * as React from "react";

import {
  bindingRows,
  bindableSkills,
  SKILL_SCOPES,
  skillBindingCapWarning,
  type AgentSkillBindings,
  type ProjectSkill,
  type SkillScope,
} from "@/features/agents/lib/skillLibrary";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

type AgentSkillsDialogProps = {
  agent: AgentSkillBindings;
  skills: readonly ProjectSkill[];
  open: boolean;
  isPending: boolean;
  /** Command failure — inline next to the bindings it did NOT change. */
  error: string | null;
  /** Settled-edit notice (published or queued), including the consequence. */
  notice: string | null;
  onBind: (skillId: string, scope: SkillScope) => void;
  onUnbind: (skillId: string) => void;
  onClearAll: () => void;
  onOpenChange: (open: boolean) => void;
};

/**
 * The binding editor for one agent. Every destructive row states the
 * consequence (what the agent stops loading, and when) before the click, and
 * the result of the edit — including a queued relay outcome — after it.
 */
export function AgentSkillsDialog({
  agent,
  skills,
  open,
  isPending,
  error,
  notice,
  onBind,
  onUnbind,
  onClearAll,
  onOpenChange,
}: AgentSkillsDialogProps) {
  const [selectedSkillId, setSelectedSkillId] = React.useState("");
  const [scope, setScope] = React.useState<SkillScope>("all");
  const [clearOpen, setClearOpen] = React.useState(false);
  const rows = bindingRows(agent, skills);
  const bindable = bindableSkills(agent, skills);
  const warning = skillBindingCapWarning(agent, skills);
  const nameId = `bind-skill-${agent.personaId}`;
  const scopeId = `bind-scope-${agent.personaId}`;

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Skills for {agent.displayName}</DialogTitle>
            <DialogDescription>
              Bindings apply from the agent&apos;s next session.
            </DialogDescription>
          </DialogHeader>

          {agent.readError ? (
            <p className="text-sm text-destructive" role="alert">
              This agent&apos;s bindings can&apos;t be read right now, so they
              are unknown — not empty: {agent.readError}
            </p>
          ) : (
            <div className="space-y-4">
              {notice ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {notice}
                </p>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error} — {agent.displayName} keeps the bindings listed here.
                </p>
              ) : null}
              {warning.message ? (
                <p
                  className={
                    warning.level === "at"
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                  role="status"
                >
                  {warning.message}
                </p>
              ) : null}

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Bound skills</h3>
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No skills bound yet.
                  </p>
                ) : (
                  <ul className="space-y-2" aria-label="Bound skills">
                    {rows.map((row) => {
                      const label = row.skill?.name ?? row.skillId;
                      return (
                        <li
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                          key={row.skillId}
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-medium">{label}</p>
                            <p className="text-2xs text-muted-foreground">
                              {row.scope || "no scope"} scope
                              {row.skill === null
                                ? " · not in the local library list"
                                : null}
                            </p>
                            {row.invalid ? (
                              <Badge variant="warning">
                                Ignored by the harness
                              </Badge>
                            ) : null}
                          </div>
                          <Button
                            aria-label={`Unbind ${label} from ${agent.displayName}`}
                            disabled={isPending}
                            onClick={() => onUnbind(row.skillId)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Unbind
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <label className="text-sm font-medium" htmlFor={nameId}>
                  Bind a skill
                </label>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-40 flex-1 space-y-1.5">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      id={nameId}
                      onChange={(event) =>
                        setSelectedSkillId(event.target.value)
                      }
                      value={selectedSkillId}
                    >
                      <option value="">Choose a skill…</option>
                      {bindable.map((skill) => (
                        <option key={skill.id} value={skill.id}>
                          {skill.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor={scopeId}>
                      Applies to
                    </label>
                    <select
                      className="flex h-9 rounded-md border border-input bg-background px-3 text-sm"
                      id={scopeId}
                      onChange={(event) =>
                        setScope(event.target.value as SkillScope)
                      }
                      value={scope}
                    >
                      {SKILL_SCOPES.map((option) => (
                        <option key={option} value={option}>
                          {option === "developers"
                            ? "Developer work"
                            : "All work"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    disabled={isPending || selectedSkillId === ""}
                    onClick={() => {
                      if (selectedSkillId === "") return;
                      onBind(selectedSkillId, scope);
                      setSelectedSkillId("");
                    }}
                    type="button"
                  >
                    Bind
                  </Button>
                </div>
                {bindable.length === 0 ? (
                  <p className="text-2xs text-muted-foreground">
                    Every skill in this library is already bound.
                  </p>
                ) : null}
              </section>

              <section className="space-y-2">
                <Button
                  disabled={isPending || rows.length === 0}
                  onClick={() => setClearOpen(true)}
                  type="button"
                  variant="outline"
                >
                  Unbind all
                </Button>
                <p className="text-2xs text-muted-foreground">
                  Removes every skill binding from {agent.displayName}.
                </p>
              </section>
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={setClearOpen} open={clearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unbind every skill from {agent.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {agent.displayName} will stop loading all {rows.length} of its
              skills on its next session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={() => {
                  onClearAll();
                }}
                type="button"
                variant="destructive"
              >
                Unbind all
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
