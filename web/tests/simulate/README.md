# The simulation

One command plays a scripted story in the app and writes a timeline report
with a screenshot per step (plan §9,
[docs/funding-and-governance-plan.md](../../../docs/funding-and-governance-plan.md)).

```bash
just simulate          # builds the client, plays the story, writes the report
```

The report lands at `web/test-results/simulate/timeline.md`, screenshots
beside it. The run fails if any step's claim is false or any invariant it
reads does not hold.

## The pieces

| file | what it is |
| --- | --- |
| `cast.ts` | the seats a story can name: one founder, three backers, two contributors, an agent and its sponsor, two verifiers, and a troublemaker |
| `invariants.ts` | the four things that may never break — treasury solvent, supply conserved, no spend beyond an allowance, exits neutral |
| `story.ts` | the runner: refuses a story that measures nothing, walks the steps, and renders the timeline |
| `scenes.ts` | the scenes themselves, each step naming who acts and what it proves |
| `story.spec.ts` | the play: drives the browser through the scenes and collects the readings |
| `story.test.mjs` | the runner's own tests (`pnpm test`), no browser needed |

Only `story.spec.ts` touches Playwright. The story and the runner are plain
modules, so a scene can be reasoned about and tested without a browser.

## Adding a scene

Add it to `scenes.ts`, then write its play in `story.spec.ts`. The play is
bound to the step's `does` text: rewording a step without updating its play
fails the run rather than silently proving nothing.

Every step reads all four invariants, even when it moves no money. That is
the point — they are the run's continuous conditions, so a scene cannot leave
the treasury empty and still look like it worked.

## What is stubbed

This skeleton plays against the client with a mocked relay
(`tests/helpers/funding-fixture.ts`) and no chain, so the invariant readings
say "no money in this scene" in words instead of claiming a treasury was
checked. The plan's world — a real relay and Anvil with time jumps — swaps in
behind `story.spec.ts` without changing the story or the runner.

Still to come, as the plan lists them:

- happy path: idea, supporters, stance changes, raise, graduation, finance
  office, budget lines, milestone claim, challenge window, payout, voting
  power growing, proposal, ragequit
- failed raise with refunds
- contributors-only project
- open sale
- proposal funding with vouchers (joined, unjoined, failed milestone)
- imported token
- orphaned agent
- attacks: self-approval, split wallets, flash buyer, buy-then-ragequit
