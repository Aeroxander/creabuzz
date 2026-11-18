/**
 * Query/mutation hooks for the skill library.
 *
 * The queries cross IPC exactly twice per refresh (skills, bindings) and the
 * two mutations map 1:1 onto the backend commands. Deliberate asymmetry on
 * failure: a rejected binding edit does NOT invalidate the bindings query, so
 * a failed unbind leaves the binding on screen instead of optimistically
 * hiding it (rule: caught failures are not successes).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";

import type {
  AgentSkillBindings,
  ProjectSkill,
  SkillBindingChange,
  SkillBindingChangeResult,
} from "./skillLibrary";

export const projectSkillsQueryKey = ["project-skills"] as const;
export const skillBindingsQueryKey = ["skill-bindings"] as const;

export type PublishSkillInput = {
  /** Raw SKILL.md text; takes precedence over `url` server-side too. */
  content?: string;
  /** https URL fetched server-side with a 64 KiB bound. */
  url?: string;
  source?: string;
  appliesTo?: string;
};

type SetSkillBindingInput = {
  personaId: string;
  change: SkillBindingChange;
};

export function fetchProjectSkills(): Promise<ProjectSkill[]> {
  return invokeTauri<ProjectSkill[]>("fetch_project_skills");
}

export function fetchSkillBindings(): Promise<AgentSkillBindings[]> {
  return invokeTauri<AgentSkillBindings[]>("fetch_skill_bindings");
}

export function publishSkill(input: PublishSkillInput): Promise<ProjectSkill> {
  return invokeTauri<ProjectSkill>("publish_skill", { input });
}

export function setSkillBinding(
  input: SetSkillBindingInput,
): Promise<SkillBindingChangeResult> {
  return invokeTauri<SkillBindingChangeResult>("set_persona_skill_binding", {
    input,
  });
}

export function useSkillLibraryQueries() {
  const skillsQuery = useQuery<ProjectSkill[]>({
    queryKey: projectSkillsQueryKey,
    queryFn: fetchProjectSkills,
    staleTime: 30_000,
  });
  const bindingsQuery = useQuery<AgentSkillBindings[]>({
    queryKey: skillBindingsQueryKey,
    queryFn: fetchSkillBindings,
    staleTime: 15_000,
  });
  return { skillsQuery, bindingsQuery };
}

export function useSkillLibraryMutations() {
  const queryClient = useQueryClient();

  const publishSkillMutation = useMutation({
    mutationFn: publishSkill,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectSkillsQueryKey });
    },
  });

  const setBindingMutation = useMutation({
    mutationFn: setSkillBinding,
    // Only a settled edit refreshes the durable list. On error nothing is
    // invalidated, so the previously rendered bindings stay put — the failure
    // is reported, never absorbed into a changed view.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: skillBindingsQueryKey });
    },
  });

  return { publishSkillMutation, setBindingMutation };
}
