/**
 * The story runner (plan §9): a scripted story is scenes of steps, each naming
 * who acts and what it must prove, and the runner turns one into a timeline
 * report with the four invariants' readings beside every step.
 *
 * Two jobs, both real:
 *
 * - `storyIssues` refuses a story that cannot be trusted — a step narrated by
 *   someone not in the cast, a step that promises no check at all, two scenes
 *   with the same id, an invariant nothing ever reads. A story that does not
 *   measure anything is a demo, not a simulation.
 * - `runStory` walks the steps in order and insists the world answered for
 *   every invariant each step named. A step that promised "exits neutral" and
 *   reported nothing fails the run rather than quietly passing it.
 *
 * Pure: no relay, no chain, no browser. `story.test.mjs` drives it under
 * `node --test`; the real-relay spec supplies the readings.
 */

import { castMember, type CastMember } from "./cast.ts";
import {
  INVARIANTS,
  INVARIANT_LABELS,
  checksHold,
  failingChecks,
  uncheckedSteps,
  type Check,
  type Invariant,
  type TimelineEntry,
} from "./invariants.ts";

export interface StoryStep {
  /** The cast member id that acts. */
  actor: string;
  /** What they do, in plain words. */
  does: string;
  /** What this step is here to prove — the reason it is in the story. */
  proves: string;
  /** The invariants this step reads immediately after acting. */
  checks: readonly Invariant[];
  /** A screenshot path or note the step leaves behind. */
  artifact?: string;
}

/**
 * Where a scene has to be played. Some scenes are about what a surface says
 * and run against the client alone; others move money and need a chain. The
 * distinction is the honest one: a scene is never "played" by a world that
 * cannot actually perform it.
 */
export type StoryWorld = "client" | "chain";

export interface Scene {
  id: string;
  title: string;
  /** What the scene as a whole proves. */
  proves: string;
  /** The world this scene has to be played against. */
  world: StoryWorld;
  steps: readonly StoryStep[];
}

export interface Story {
  title: string;
  scenes: readonly Scene[];
}

export function stepKey(scene: Scene, index: number): string {
  return `${scene.id}#${index}`;
}

/**
 * Everything wrong with a story before it runs. Empty means the story is
 * worth running; each message names the scene and step so the author can
 * find it without reading the whole file.
 */
export function storyIssues(
  story: Story,
  cast: readonly CastMember[],
): string[] {
  const issues: string[] = [];
  const known = new Set(cast.map((member) => member.id));
  const seen = new Set<string>();
  const checked = new Set<Invariant>();

  for (const scene of story.scenes) {
    if (seen.has(scene.id))
      issues.push(`two scenes share the id "${scene.id}"`);
    seen.add(scene.id);
    if (scene.steps.length === 0) {
      issues.push(`scene "${scene.id}" has no steps`);
      continue;
    }
    scene.steps.forEach((step, index) => {
      const where = `scene "${scene.id}" step ${index + 1}`;
      if (!known.has(step.actor)) {
        issues.push(
          `${where} is narrated by "${step.actor}", who is not in the cast`,
        );
      }
      if (step.checks.length === 0) {
        issues.push(`${where} ("${step.does}") reads no invariant`);
      }
      for (const invariant of step.checks) checked.add(invariant);
    });
  }

  for (const invariant of INVARIANTS) {
    if (!checked.has(invariant)) {
      issues.push(`no step ever reads "${INVARIANT_LABELS[invariant]}"`);
    }
  }
  return issues;
}

/** What the world reports for one step — sync, or read back from a chain. */
export type Reading = (
  step: StoryStep,
  key: string,
) => readonly Check[] | Promise<readonly Check[]>;

export interface StoryReport {
  title: string;
  entries: TimelineEntry[];
  /** Steps whose world reading did not cover what the step promised. */
  unanswered: string[];
  /** Steps that read nothing at all — a story cannot stand behind these. */
  unchecked: string[];
  /** Every invariant reading that did not hold, across the whole story. */
  failures: Check[];
}

/**
 * Walk the story and record the timeline. The world must answer for every
 * invariant each step named — anything less is recorded in `unanswered`, and
 * the report is a failure either way.
 *
 * `only` limits the walk to the scenes one world can play; the report says
 * which, so a client-only run can never read as if it had moved money.
 */
export async function runStory(
  story: Story,
  reading: Reading,
  only?: StoryWorld,
): Promise<StoryReport> {
  const entries: TimelineEntry[] = [];
  const unanswered: string[] = [];
  const failures: Check[] = [];
  const scenes = only
    ? story.scenes.filter((s) => s.world === only)
    : story.scenes;

  for (const scene of scenes) {
    for (let index = 0; index < scene.steps.length; index += 1) {
      const step = scene.steps[index];
      const key = stepKey(scene, index);
      const checks = await reading(step, key);
      const reported = new Set(checks.map((check) => check.invariant));
      for (const invariant of step.checks) {
        if (!reported.has(invariant)) unanswered.push(`${key} (${invariant})`);
      }
      failures.push(...failingChecks(checks));
      entries.push({
        scene: scene.id,
        step: step.does,
        actor: step.actor,
        checks: [...checks],
        ...(step.artifact ? { artifact: step.artifact } : {}),
      });
    }
  }

  return {
    title: story.title,
    entries,
    unanswered,
    unchecked: uncheckedSteps(entries),
    failures,
  };
}

export function reportHolds(report: StoryReport): boolean {
  return (
    report.unanswered.length === 0 &&
    report.unchecked.length === 0 &&
    report.failures.length === 0
  );
}

function mark(holds: boolean): string {
  return holds ? "✓" : "✗";
}

/**
 * The timeline as markdown — the run's one artifact a human reads. A step is
 * one line, with its invariant readings under it; when they all held and say
 * the same thing they collapse to one line, so the failures stay findable
 * instead of drowning in ticks. Every step names what it left behind.
 */
export function renderReport(report: StoryReport): string {
  const lines: string[] = [`# ${report.title}`, ""];
  let scene = "";
  for (const entry of report.entries) {
    if (entry.scene !== scene) {
      scene = entry.scene;
      lines.push(`## ${scene}`, "");
    }
    const actor = castMember(entry.actor)?.name ?? entry.actor;
    lines.push(`- **${actor}** — ${entry.step}`);
    const details = new Set(entry.checks.map((check) => check.detail));
    if (
      entry.checks.length > 0 &&
      checksHold(entry.checks) &&
      details.size === 1
    ) {
      const names = entry.checks
        .map((check) => INVARIANT_LABELS[check.invariant])
        .join("; ");
      lines.push(`  - ${mark(true)} ${names} — ${[...details][0]}`);
    } else {
      for (const check of entry.checks) {
        lines.push(
          `  - ${mark(check.holds)} ${INVARIANT_LABELS[check.invariant]}: ${check.detail}`,
        );
      }
      if (entry.checks.length === 0) {
        lines.push(`  - ${mark(false)} this step checked nothing`);
      }
    }
    if (entry.artifact) lines.push(`  - artifact: ${entry.artifact}`);
  }
  lines.push("");
  if (report.unanswered.length > 0) {
    lines.push(`## Unanswered checks`, "");
    for (const key of report.unanswered) lines.push(`- ${key}`);
    lines.push("");
  }
  if (report.unchecked.length > 0) {
    lines.push(`## Steps that checked nothing`, "");
    for (const step of report.unchecked) lines.push(`- ${step}`);
    lines.push("");
  }
  if (report.failures.length > 0) {
    lines.push(`## Invariant failures`, "");
    for (const check of report.failures) {
      lines.push(`- ${INVARIANT_LABELS[check.invariant]}: ${check.detail}`);
    }
    lines.push("");
  }
  lines.push(
    reportHolds(report)
      ? `All ${report.entries.length} steps held every invariant they read.`
      : `The story did not hold: ${report.failures.length} failed reading(s), ${report.unanswered.length} unanswered, ${report.unchecked.length} unchecked.`,
  );
  return lines.join("\n");
}
