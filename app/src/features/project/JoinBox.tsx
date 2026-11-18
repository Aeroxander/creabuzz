import {
  markAskAfterSignUp,
  takeAskAfterSignUp,
} from "@creaton/core/project/join.ts";
import { useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { type Project, projectPath } from "./project-record";
import { hasAsked, type ProjectActivity, useAskToJoin } from "./use-project";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Ask to join: one press for someone with an account. Signed out, the press is remembered and sent by itself once the
 * account exists, so there is no second press (the milestone 0 budget: 4 presses and 1 field with the age and terms
 * boxes). The founder, and people already on the team, see where they stand instead.
 */
export function JoinBox({
  project,
  activity,
  onTeam,
  secondary = false,
}: {
  project: Project;
  activity: ProjectActivity | undefined;
  onTeam: boolean;
  /** When another action is the screen's main one (an open round's Back), Ask to join is not green. */
  secondary?: boolean;
}) {
  const { pubkey } = useAccount();
  const navigate = useNavigate();
  const ask = useAskToJoin(project);
  const toast = useToast();
  const asked = hasAsked(project, activity, pubkey) || ask.isSuccess;
  const sentAfterSignUp = useRef(false);

  const send = () =>
    ask.mutate(undefined, {
      onError: (error) => toast(error.message, "problem"),
    });

  // An Ask pressed before signing up is sent once the account exists and the project's asks are read.
  useEffect(() => {
    if (!pubkey || !activity || sentAfterSignUp.current) return;
    if (!takeAskAfterSignUp(sessionStore(), project.coordinate)) return;
    sentAfterSignUp.current = true;
    if (pubkey === project.author || onTeam || asked) return;
    send();
  });

  if (pubkey === project.author) return null;
  if (onTeam)
    return (
      <p
        className="glass chip chip-ok self-start text-sm"
        data-testid="join-on-team"
      >
        You're on the team
      </p>
    );
  if (asked)
    return (
      <p
        className="glass flex items-center gap-2 rounded-xl px-3 py-3 text-sm"
        data-testid="join-asked"
        role="status"
      >
        <Check aria-hidden="true" className="text-mint-ink" size={18} />
        Asked to join. The founder will see it.
      </p>
    );
  return (
    <Button
      block
      data-testid="join-ask"
      disabled={ask.isPending}
      variant={secondary ? "secondary" : "primary"}
      onClick={() => {
        if (pubkey) {
          send();
          return;
        }
        markAskAfterSignUp(sessionStore(), project.coordinate);
        void navigate({
          to: "/welcome",
          search: { next: projectPath(project) },
        });
      }}
    >
      Ask to join
    </Button>
  );
}
