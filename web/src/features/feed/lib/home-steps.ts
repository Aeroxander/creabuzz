/**
 * What Home's "Get started" list asks of someone who just signed up, which depends on why they came.
 *
 * Someone who came to help finds a project and follows it or a person; someone starting a project publishes it with the
 * work it needs. They are two different first hours, so each has its own list, and neither is asked to do the other's.
 * Nothing in either is about money: this release has no sales (D108). Every box is ticked only for something the app can
 * verify, so a ticked box never lies.
 *
 * Pure and alias-free: `home-steps.test.mjs` drives it under `node --test`.
 */

import {
  pickUserName,
  type UserNameProfile,
} from "../../profiles/lib/user-label.ts";

export type Role = "helper" | "founder";

/** Most people come to take part, so that is where someone starts until they say otherwise. */
export const DEFAULT_ROLE: Role = "helper";

/** The stored choice; anything else (including the old "backer") reads as the default. */
export function parseRole(raw: string | null | undefined): Role {
  return raw === "founder" ? raw : DEFAULT_ROLE;
}

/** What the app can tell about this person. */
export interface Signals {
  /** They have a name on their profile. */
  named: boolean;
  /** They opened a project's page in this browser. */
  lookedAtProject: boolean;
  /** They follow a project or a person. */
  follows: boolean;
  /** They published a project or an idea. */
  published: boolean;
}

/**
 * Whether a profile carries a name the person chose. A profile with only an "about" or a picture has none, and the
 * short key the app shows in its place is not one either.
 */
export function hasChosenName(
  profile: UserNameProfile | undefined | null,
): boolean {
  return pickUserName(profile) !== null;
}

export interface Step {
  id: string;
  done: boolean;
  label: string;
  hint: string;
  to: "/discover" | "/start/contributor" | null;
  /** Its Go opens the profile editor in place, rather than going somewhere. */
  editsProfile?: true;
}

export function stepsFor(role: Role, signals: Signals): Step[] {
  const name: Step = {
    id: "name",
    done: signals.named,
    label: "Add your name and a picture",
    hint: "The picture is optional.",
    to: null,
    editsProfile: true,
  };
  if (role === "helper") {
    return [
      name,
      {
        id: "look",
        done: signals.lookedAtProject || signals.follows,
        label: "Look at a project",
        hint: "See what it is making and the work it needs.",
        to: "/discover",
      },
      {
        id: "follow",
        done: signals.follows,
        label: "Follow a project or a person",
        hint: "Their news shows up under Following.",
        to: "/discover",
      },
    ];
  }
  return [
    name,
    {
      id: "publish",
      done: signals.published,
      label: "Start your project",
      hint: "Say what it is for and list the work it needs.",
      to: "/start/contributor",
    },
  ];
}

/** The way in is done when every step is. */
export function wayInDone(steps: readonly Step[]): boolean {
  return steps.every((step) => step.done);
}
