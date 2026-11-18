# Deming in Creaton: a learning system for people working with AI

Updated 2026-11-01. This is an implementation map and a bounded extension of
[PROJECT-CYCLE.md](PROJECT-CYCLE.md), not fourteen new screens or a claim that software can install a management
philosophy. The core contributor cycle already exists (D154, D157 to D169). The changes in this pass concern its
check note and AI guidance; no contract, event kind, award rule or financial permission changes.

Creaton's aim is to help people build worthwhile projects together at their own pace. AI can make some attempts
cheaper and faster. Choosing useful work, checking it, understanding customers and repairing mistakes still require
knowledge, time and responsibility. The adaptations below are ours, informed by the user's articles and the primary
Deming Institute sources linked alongside them.

## Four connected areas, one working cycle

The Institute describes [four connected areas of knowledge](https://deming.org/explore/sopk/). For Creaton, they guide
the same project workflow rather than become separate scores:

| Area | What it means in this product | Existing support and limit |
|---|---|---|
| A system | Help the whole project serve its users; examine dependencies and hand-offs. | Aim, three priorities, work areas and a shared project board exist. The app does not prove that local task completion improved the whole project. |
| Variation | Separate observations from an explanation of why they vary. | Review-cause counts and check notes exist. There are no calculated control limits, trend alerts or comparable-process baselines. |
| Knowledge | Make a prediction, try something and compare it with observations. | Predictions, check dates and keep/change/drop exist. Answering yes, partly or no needs a statement of what was observed; "not yet" preserves uncertainty. |
| Psychology | Make it safe to report uncertainty, ask for help and take pride in good work. | Optional unmet-conditions text, examples and editable AI drafts help. Public claim history and financial incentives create tensions; the app cannot guarantee trust or safety by itself. |

The [PDSA cycle](https://deming.org/explore/pdsa/) puts learning from a prediction and its result at the centre of the
work. Creaton's check note is one place to do that. It is not proof of learning merely because someone filled it in.

## The fourteen points, adapted to the product

The left column is a short paraphrase of the Institute's [14 Points](https://deming.org/explore/fourteen-points/).
The product choices and AI adaptations are Creaton's interpretation, not statements Deming made about AI.

| Point | Creaton's application | Status |
|---|---|---|
| 1. Sustained purpose | A project says whom it serves and what it aims to change. AI-generated activity is evaluated against that aim. | Aim and priorities built. Customer benefit still needs evidence. |
| 2. Management learns a new approach | Founders explain assumptions and accept responsibility for decisions, including tool choices. | Challenge and check-note forms built; leadership remains a human practice. |
| 3. Quality begins upstream | Agree on "done when", supply context, and check work before submission. Keep independent review and appropriate tests. | Words, self-check evidence and review built. The AI text checker cannot inspect linked artifacts. |
| 4. Consider total cost and trusted relationships | Choose tools and collaborators for reliable delivery, including review, rework, privacy and switching costs, rather than token price alone. | Guidance; no supplier or model-selection score is built. Avoid making this a mandate to depend on one model vendor. |
| 5. Improve the system | Compare predictions and observations; keep a working method, test a change, or seek more evidence. | Check-note cycle built; this pass removes the implication that each note must invent a process change. |
| 6. Train through the work | Start with a small piece, examples and help from someone who understands the context. | Newcomer guidance and optional interviewer built; a mentoring programme is not built. |
| 7. Leadership helps work succeed | Surface unclear requirements, missing access and missing context so the team can remove obstacles. | Review reasons and waiting-work views built. Counts do not establish a person's ability or a cause by themselves. |
| 8. Reduce fear | Make uncertainty and unmet conditions sayable; do not turn AI into an automatic judge of people. | AI drafts require a person to decide; public work records still need careful treatment. |
| 9. Cooperate across roles | Founders, contributors and reviewers share project discussion and evidence. Advisors can participate through the same social surfaces. | Project board and work history built; advisor-specific terms and matching remain separate work. |
| 10. Replace exhortation with useful conditions | Improve words, access and tools instead of urging people or agents to produce more. | Review-cause prompts support this; it is not an automatic management diagnosis. |
| 11. Avoid quotas as management | Look at useful outcomes rather than claims closed, code generated, tokens consumed or awards collected. | Check notes ask what changed for users. No new productivity score is introduced. |
| 12. Protect pride in workmanship | Let people explain and improve work; preserve evidence and financial rights without ranking people by failures. | Reviewed work and contribution records exist. Compensation and public verdicts are an explicit unresolved tension, not proof this point is satisfied. |
| 13. Support continued learning | Use questions and worked examples to build understanding, and retain reasons that help the next contributor. | Examples and project history built; a shared training library and learning pathways are not built. |
| 14. Involve everyone | Anyone in the community can contribute observations and question assumptions on the project board. | Discussion built; the founder still publishes the check note, and holders retain the existing money decisions. |

## The AI-era rules

1. **A generated explanation is a hypothesis until checked.** The AI uses supplied observations, identifies what is
   missing and keeps suggestions distinct from facts. Confidence, fluency and agreement between models do not verify
   an artifact or a customer outcome.
2. **Help people examine their own thinking.** Drafts, questions and text comparisons can help; AI does not award,
   reject, rank a person or publish a project decision. A person accepts or edits a draft. Independent reviewers and
   appropriate runtime checks remain necessary.
3. **Allow a reasoned decision to keep the method.** A team can say that evidence supports continuing, or that the
   result is not known yet. A verified defect, incident or safety risk can still require prompt action; the caution
   about noise is not a reason to ignore it.
4. **Do not diagnose a process from a tally.** A few rejected claims, a slower week or a model's opinion do not establish
   common or special causes, a trend, or a person's competence. Explain what was counted and what remains unknown.
5. **Evaluate the whole cost of automation.** Include verification, integration, inference, data exposure and rework.
   Choosing a cheaper model or producing more drafts is not itself an improvement. Keep agents' authority and spending
   bounded by the existing permission system.
6. **Keep help voluntary and visible.** The cycle works without the AI service. When used, the form says that text goes
   to the server's configured AI service. Project publication is separate from provider processing.

These are guardrails, not a promise that prompts can enforce model truthfulness. Test the workflow and examine actual
outcomes. Prompt tests do not establish live-model reliability.

## This implementation pass

- Keep the existing `CheckNote.change` field and signed-update format. Change the question and rendered heading to
  **How we work next**: keep the method with a reason, try a change, or say what must be learned first.
- When answering a prediction yes, partly or no, ask for what was observed in the existing per-item explanation.
  A "not yet" answer does not need invented evidence. The answer remains the founder's report, not an independently
  verified outcome.
- Tell the AI drafter to distinguish observations from suggestions, preserve unknowns, and avoid turning one result
  or review-cause counts into a diagnosis or demand for change.
- Retain human acceptance, malformed-response handling, stale-draft protection and failed-publication recovery.

No score, leaderboard, statistical engine, new mandatory ritual or contract mechanism is added. Existing notes stay
readable. See the implementation in [checkNote.ts](../../packages/creaton-core/src/launchpad/checkNote.ts),
[checkNoteAi.ts](../../packages/creaton-core/src/launchpad/checkNoteAi.ts) and
[CheckNoteCard.tsx](../../web/src/features/launchpad/ui/CheckNoteCard.tsx), with the adjacent core regression tests.

## What the pilot should show

Use a real project and its existing check rhythm. Record a few concrete cases rather than set learning quotas:

- A team keeps a method and explains why, publishes the note, and sees that reason preserved beside a money vote.
- An expected outcome happens only partly. The founder states what was observed; completed work is not presented as
  proof that the wider outcome happened.
- A result is unknown. The note and AI draft keep it unknown instead of inventing an answer.
- A review reveals missing context or access. The team can repair that condition and help the person try again.
- A founder edits while an AI draft is pending. The later reply never replaces the newer thinking.
- A newcomer can complete useful work without using AI, learning fourteen principles or completing a management course.

Ask whether the note changed a real decision, exposed an assumption, or helped someone get unstuck, and how much time
it took. A completed form, a rising claim count or a polished AI summary is not evidence of product success.

## Later, only if the pilot gives a reason

Statistical process views need a clear question, consistent definitions, comparable work and a method justified for
the observations. Changes to models, prompts, access and work type can change the system being measured. Retain that
context before pooling results. Until there is meaningful data, report observations and uncertainty rather than
inventing normal ranges, significance or control limits.

Shared decision notes, reusable onboarding material, evaluation examples for AI tools, and stronger support for mentors
may help later. Do not expand them into new pilot gates without observing a real problem. Keep advisor/investor matching,
fundraising rights and any changes to compensation in their own design work.

## Tensions to keep visible

Reviewed Shares can compensate useful contributions, but piece-by-piece rewards can also encourage people to optimise
what earns an award instead of what helps the project. Test this in the pilot; do not claim that removing a leaderboard
solves incentives. This pass does not change the economics.

Contribution records include claims, verdicts and evidence, sometimes onchain. Do not promise that rejected work is
private or erase evidence needed to question a decision. Avoid publishing new per-person failure scores or feeding
such rankings to AI. Discussion moderation must preserve the evidence and financial-rights boundaries already required
by the product vision.

The platform provides records and affordances. People still create the trust, cooperation and willingness to surface
problems that make the method work.
