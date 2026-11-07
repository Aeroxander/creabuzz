import { Plus, Trash2 } from "lucide-react";

import {
  TextAreaField,
  TextField,
} from "@/features/launchpad/ui/decision-fields";
import { Button } from "@/shared/ui/button";

import {
  MAX_FIRST_PROJECTS,
  type ProjectDraft,
  type ProjectPart,
  emptyProject,
} from "../lib/contributor-project";

/**
 * The first projects: what people can work on from the first day, each with its name, the Shares it can award and what
 * finished work looks like. One is enough; a team from the Projects board gets one per role (D84). Up to eight; more
 * can be voted in later.
 */
export function FirstProjectsField({
  projects,
  cap,
  onChange,
  problemIndex,
  problem = null,
  problemPart = null,
}: {
  projects: ProjectDraft[];
  /** The per-project limit, used as a new project's size. */
  cap: string;
  onChange: (projects: ProjectDraft[]) => void;
  /** The project a problem is about, outlined. */
  problemIndex: number | null;
  /** What is wrong with it, said under the box it is about. */
  problem?: string | null;
  /** Which box of that work area the problem is about; its name when not said. */
  problemPart?: ProjectPart | null;
}) {
  // The problem goes under one box only, the one it is about, which is also the box marked invalid and focused.
  const errorAt = (index: number, part: ProjectPart) =>
    problem !== null &&
    (problemIndex ?? 0) === index &&
    (problemPart ?? "name") === part
      ? problem
      : null;
  const update =
    (index: number, field: keyof ProjectDraft) => (value: string) =>
      onChange(
        projects.map((project, i) =>
          i === index ? { ...project, [field]: value } : project,
        ),
      );
  const several = projects.length > 1;
  return (
    <fieldset
      className="m-0 flex flex-col gap-3 p-0"
      data-testid="contributor-projects"
    >
      <legend className="mb-1 text-sm font-semibold">
        {several ? "First work areas" : "First work area"}
      </legend>
      <p className="-mt-1 text-xs text-muted-foreground">
        What people can work on from the first day. You manage each one: you
        accept each submission for review, the reviewers judge it, and
        Shareholders vote on the award.
      </p>
      {projects.map((project, index) => (
        <div
          className={`flex flex-col gap-2 rounded-lg border p-3 ${problemIndex === index ? "border-destructive" : ""}`}
          data-testid={`contributor-project-${index}`}
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until named, and are only added or removed at the end or by button
          key={index}
        >
          {/* Top-aligned, so a hint under the name never pushes the Shares box down; stacked on a phone. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <TextField
                error={errorAt(index, "name")}
                hint={
                  index === 0
                    ? "A word or two, for example: Bug reports."
                    : undefined
                }
                label={several ? `Work area ${index + 1}` : "Name"}
                onChange={update(index, "name")}
                placeholder="Bug reports"
                testId={
                  index === 0
                    ? "contributor-project-name"
                    : `contributor-project-name-${index}`
                }
                value={project.name}
              />
            </div>
            <div className="shrink-0 sm:w-36">
              <TextField
                error={errorAt(index, "shares")}
                inputMode="numeric"
                label="Shares"
                onChange={update(index, "shares")}
                testId={`contributor-project-shares-${index}`}
                value={project.shares}
              />
            </div>
            {several ? (
              <Button
                aria-label={`Remove ${project.name || `work area ${index + 1}`}`}
                className="shrink-0 self-end sm:mt-6 sm:self-start"
                onClick={() => onChange(projects.filter((_, i) => i !== index))}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
          <TextAreaField
            error={errorAt(index, "check")}
            hint={
              index === 0
                ? "The reviewers check each submission against these words. They can't be changed later."
                : undefined
            }
            label="What finished work looks like"
            onChange={update(index, "check")}
            placeholder="e.g. The pages are published and reviewed"
            testId={
              index === 0
                ? "contributor-project-check"
                : `contributor-project-check-${index}`
            }
            value={project.check}
          />
        </div>
      ))}
      {projects.length < MAX_FIRST_PROJECTS ? (
        <Button
          className="self-start"
          data-testid="contributor-project-add"
          onClick={() => onChange([...projects, emptyProject(cap)])}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus aria-hidden className="mr-1 h-4 w-4" /> Add another work area
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Eight is the most a project starts with; the project can vote to add
          more work areas later.
        </p>
      )}
    </fieldset>
  );
}
