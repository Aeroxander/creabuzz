import { Plus, Trash2 } from "lucide-react";

import {
  TextAreaField,
  TextField,
} from "@/features/launchpad/ui/decision-fields";
import { Button } from "@/shared/ui/button";

import {
  MAX_FIRST_PROJECTS,
  type ProjectDraft,
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
}: {
  projects: ProjectDraft[];
  /** The per-project limit, used as a new project's size. */
  cap: string;
  onChange: (projects: ProjectDraft[]) => void;
  /** The project a problem is about, outlined. */
  problemIndex: number | null;
}) {
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
        {several ? "First projects" : "First project"}
      </legend>
      <p className="-mt-1 text-xs text-muted-foreground">
        What people can work on from the first day. You manage each one: you
        take each claim on, the reviewers judge it, and the project votes the
        award.
      </p>
      {projects.map((project, index) => (
        <div
          className={`flex flex-col gap-2 rounded-lg border p-3 ${problemIndex === index ? "border-destructive" : ""}`}
          data-testid={`contributor-project-${index}`}
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until named, and are only added or removed at the end or by button
          key={index}
        >
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                hint={
                  index === 0 ? "A word or two, for example: docs." : undefined
                }
                label={several ? `Project ${index + 1}` : "Name"}
                onChange={update(index, "name")}
                placeholder="docs"
                testId={
                  index === 0
                    ? "contributor-project-name"
                    : `contributor-project-name-${index}`
                }
                value={project.name}
              />
            </div>
            <div className="w-36 shrink-0">
              <TextField
                inputMode="numeric"
                label="Shares"
                onChange={update(index, "shares")}
                testId={`contributor-project-shares-${index}`}
                value={project.shares}
              />
            </div>
            {several ? (
              <Button
                aria-label={`Remove ${project.name || `project ${index + 1}`}`}
                className="mb-0.5 shrink-0"
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
            hint={
              index === 0
                ? "Every claim says it meets this, and the reviewers check the work against these words."
                : undefined
            }
            label="What finished work looks like"
            onChange={update(index, "check")}
            placeholder="The pages are merged and reviewed"
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
          <Plus aria-hidden className="mr-1 h-4 w-4" /> Add another project
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Eight is the most a project starts with; the project can vote to add
          more later.
        </p>
      )}
    </fieldset>
  );
}
