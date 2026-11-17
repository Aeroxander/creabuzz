import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import type { ProfileMetadata } from "../../lib/profiles";
import { nameOf } from "../../lib/profiles";
import { type Project, projectRef } from "../project/project-record";

/** A project in a list: its name, its line, who started it and how many are on it. Opens the project. */
export function ProjectCard({
  project,
  profiles,
}: {
  project: Project;
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const people = 1 + project.team.length;
  return (
    <Link
      className="glass glass-text flex flex-col gap-2 rounded-2xl p-4 transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-mint-ink"
      data-testid="project-card"
      params={{ ref: projectRef(project) }}
      to="/p/$ref"
    >
      <h3 className="headline text-xl">{project.name}</h3>
      {project.pitch ? (
        <p className="line-clamp-2 text-sm text-muted">{project.pitch}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>by {nameOf(profiles, project.author)}</span>
        <span aria-hidden="true">·</span>
        <span>started {relativeTime(project.startedAt)}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <Users aria-hidden="true" size={14} />
          <span className="num">{people}</span>
          <span className="sr-only">{people === 1 ? "person" : "people"}</span>
        </span>
      </div>
    </Link>
  );
}
