import { TEAM_ROLE_WORDS } from "@creaton/core/project/team.ts";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { nameOf, pictureOf, type ProfileMetadata } from "../../lib/profiles";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import type { Project } from "./project-record";
import {
  type ProjectActivity,
  projectPeople,
  useAcceptAsk,
} from "./use-project";

const STATE_WORDS = {
  accepted: "On the team",
  invited: "Invited, has not said yes yet",
  declined: "Said no",
  left: "Left the team",
} as const;

function Person({
  pubkey,
  profiles,
  line,
  action,
}: {
  pubkey: string;
  profiles: Record<string, ProfileMetadata> | undefined;
  line: string;
  action?: ReactNode;
}) {
  const name = nameOf(profiles, pubkey);
  return (
    <li className="flex items-center gap-3 py-2" data-testid="person">
      <Avatar
        name={name}
        picture={pictureOf(profiles, pubkey)}
        pubkey={pubkey}
      />
      <div className="min-w-0 flex-1">
        <Link
          className="-my-1.5 block truncate py-1.5 font-semibold hover:underline"
          params={{ pubkey }}
          to="/u/$pubkey"
        >
          {name}
        </Link>
        <p className="truncate text-xs text-muted">{line}</p>
      </div>
      {action}
    </li>
  );
}

/** Who is on the project, and for its founder the people waiting to join, each a press of Accept away. */
export function PeopleTab({
  project,
  activity,
  profiles,
  isFounder,
  loading,
}: {
  project: Project;
  activity: ProjectActivity | undefined;
  profiles: Record<string, ProfileMetadata> | undefined;
  isFounder: boolean;
  loading: boolean;
}) {
  const accept = useAcceptAsk(project);
  const toast = useToast();
  const people = activity ? projectPeople(project, activity) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="project-people">
      {isFounder && people && people.waiting.length > 0 ? (
        <Card data-testid="join-asks">
          <h3 className="font-semibold">Asked to join</h3>
          <ul className="divide-y divide-white/10">
            {people.waiting.map((ask, index) => (
              <Person
                action={
                  <Button
                    data-testid="join-accept"
                    disabled={accept.isPending}
                    onClick={() =>
                      accept.mutate(ask, {
                        onSuccess: () => toast("On the team", "done"),
                        onError: (error) => toast(error.message, "problem"),
                      })
                    }
                    size="sm"
                    variant={index === 0 ? "primary" : "secondary"}
                  >
                    Accept
                  </Button>
                }
                key={ask.id}
                line="Wants to join"
                profiles={profiles}
                pubkey={ask.author}
              />
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <h3 className="font-semibold">Team</h3>
        <ul className="divide-y divide-white/10">
          <Person line="Founder" profiles={profiles} pubkey={project.author} />
          {(people?.team.members ?? []).map((member) => (
            <Person
              key={member.pubkey}
              line={
                member.state === "accepted"
                  ? `${STATE_WORDS.accepted}. ${TEAM_ROLE_WORDS}`
                  : STATE_WORDS[member.state]
              }
              profiles={profiles}
              pubkey={member.pubkey}
            />
          ))}
        </ul>
        {loading ? (
          <p className="mt-2 text-xs text-muted">Reading the team…</p>
        ) : null}
      </Card>
    </div>
  );
}
