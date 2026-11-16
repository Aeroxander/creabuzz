/**
 * Join requests in Notifications: each of the founder's projects that has people asking to join, with the one press that
 * accepts (`JoinRequests.tsx`). A read that fails is said, never shown as "none".
 */

import { UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";

import type { LaunchRecord } from "../models";
import { useAsksToMe } from "../use-join";
import { JoinRequestsList } from "./JoinRequests";

export function JoinRequestsSection() {
  const read = useAsksToMe();
  const projects = read.data?.projects;
  // A project stays listed after its last ask is accepted (the read-back drops it at once), so "is on the team" is
  // said where the button was.
  const [seen, setSeen] = useState<readonly LaunchRecord[]>([]);
  useEffect(() => {
    if (!projects) return;
    setSeen((was) => {
      const known = new Set(was.map((r) => `${r.author}:${r.id}`));
      const fresh = projects
        .map((p) => p.record)
        .filter((r) => !known.has(`${r.author}:${r.id}`));
      return fresh.length === 0 ? was : [...was, ...fresh];
    });
  }, [projects]);
  if (read.isError && !read.data)
    return (
      <p
        className="border-b border-black/10 px-4 py-3 text-sm dark:border-white/10"
        data-testid="social-join-requests-failed"
        role="alert"
      >
        Couldn't check who asked to join your projects.{" "}
        <Button
          onClick={() => void read.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </p>
    );
  if (seen.length === 0 && (projects?.length ?? 0) === 0) return null;
  const listed = seen.length > 0 ? seen : (projects ?? []).map((p) => p.record);
  return (
    <section
      aria-label="Asks to join your projects"
      className="border-b border-black/10 dark:border-white/10"
      data-testid="social-join-requests"
    >
      <h2 className="flex items-center gap-2 px-4 pt-3 text-sm font-bold text-black dark:text-white">
        <UserPlus aria-hidden className="h-4 w-4" /> Asked to join
      </h2>
      <div className="flex flex-col gap-3 px-4 py-3">
        {listed.map((record) => (
          <JoinRequestsList
            key={`${record.author}:${record.id}`}
            record={record}
            waiting={
              projects?.find(
                (p) =>
                  p.record.author === record.author &&
                  p.record.id === record.id,
              )?.asks ?? []
            }
            withProject
          />
        ))}
      </div>
      {read.data && read.data.hidden > 0 ? (
        <p
          className="px-4 pb-3 text-xs text-black/60 dark:text-white/60"
          data-testid="social-join-hidden"
          role="note"
        >
          {read.data.hidden} more{" "}
          {read.data.hidden === 1 ? "ask is" : "asks are"} waiting. Accept or
          decline the ones above to see {read.data.hidden === 1 ? "it" : "them"}
          .
        </p>
      ) : null}
      {read.data?.cut ? (
        <p
          className="px-4 pb-3 text-xs text-black/60 dark:text-white/60"
          data-testid="social-join-cut"
          role="note"
        >
          More people asked than could be read, so someone may be missing here.
        </p>
      ) : null}
    </section>
  );
}
