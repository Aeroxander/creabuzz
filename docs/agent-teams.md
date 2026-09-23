# Agent Teams — self-organizing agent teams (kind:44020–44022)

`draft` `optional` `cli` `relay`

## Purpose

Fixed agent teams learn reusable *teamwork strategies* — and a team running a
learned strategy beats its best individual member **and** a perfect router to
that member. This slice-1 implementation ships the strategy language and the
execution engine from

> **Self-Organizing Agent Teams Learn to Reason Together**, arXiv
> [2609.22682](https://arxiv.org/html/2609.22682v1).

A strategy P = (S, τ, α) is an ordered list of conversational **phases**
S = [s₁, …, s_K], a shared **teamwork prompt** τ stating collaboration norms,
and persistent per-agent **role prompts** α. Each phase specifies its
participating roster slots, a round count, an information-flow mode
(`local` / `summary`), a shared step prompt, and optional per-agent step
prompts. The conductor executes phases in order and calls the LLM endpoint
once per turn; the final writer produces the team's certificate.

Demo-grade now, org-bound in slice 2. Strategy authors and run conductors
publish under their own keys; there is no authority or budget binding yet.

## Kinds

| Kind | Name | d tag | Content | Storage |
|---|---|---|---|---|
| 44020 | `KIND_TEAM_STRATEGY` | strategy id (≤64 chars) | strategy JSON (v1) | regular event; read-side LWW per `(pubkey, kind, d)` |
| 44021 | `KIND_TEAM_RUN` | run id (≤64 chars) | run JSON (v1) | same |
| 44022 | `KIND_TEAM_TURN` | `<run-id>/<phase>/<agentSlot>` (≤256 chars) | markdown turn | same |

All three are **community-level and global-only**: keyed by
`(pubkey, kind, d)` like the NIP-ORG kinds, never channel-scoped by a stray
`h` tag. They sit outside the NIP-33 parameterized-replaceable range
(30000–39999), so the relay stores every revision as a regular event and
replacement is read-side LWW — the newest revision per `(pubkey, kind, d)`
wins, exactly like kinds 44001/44002.

### 44020 — strategy

```json
{
  "v": 1,
  "name": "Mechanistic step audit",
  "description": "AIME-2024 bank strategy from arXiv 2609.22682 Appendix A …",
  "teamworkPrompt": "Treat arithmetic, algebraic transformations, case splits, and counting steps as audit targets before accepting a final answer.",
  "roles": {
    "agent-0": "Independent solver and step auditor. …",
    "agent-1": "Independent solver and step auditor. …",
    "agent-2": "Independent solver and step auditor. …"
  },
  "steps": [
    {
      "participants": ["agent-0", "agent-1", "agent-2"],
      "rounds": 1,
      "flow": "local",
      "prompt": "Audit the reasoning chains step by step. …",
      "perAgentPrompts": { "agent-2": "You are the consensus challenger. …" }
    }
  ],
  "finalWriter": "agent-2"
}
```

Semantics (validated strictly at `strategy put` **and** re-checked at run
start):

- `v` must be 1.
- `roles` is the fixed roster: 1..=6 slots, each a persistent role prompt.
- `steps` is non-empty, 1..=6 phases; each phase has 1..=4 rounds and its
  `participants` (1..=6, all ⊆ roster slots) respond once per round in the
  listed array order (the paper's strategy-specified response order, e.g.
  `["agent-2","agent-0","agent-1"]` means agent-2 speaks first).
- `flow` ∈ {`local`, `summary`}: under local flow only the phase participants
  see the phase's turns; under summary flow the exchange stays local while
  the phase runs, then a designated participant summarizes and that digest is
  added to every member's context for the rest of the run.
- `perAgentPrompts` keys must be participants of that phase.
- `finalWriter` must be a roster slot.
- Size bounds: name ≤128, description ≤1024, teamworkPrompt ≤8192, role/step
  prompts ≤4096 chars each.

### 44021 — run

`{ "v":1, "strategyId": "<id>", "problem": "<text>", "transcript":
[{"phase":1,"agentSlot":"agent-0","content":"…","tokens":321}, …],
"finalAnswer": "<certificate markdown>", "totalTokens": 1732, "model":
"<model>", "status": "complete" }`. `status` is always `complete` in slice 1:
a failed run publishes nothing (see the run loop). The transcript rows mirror
the 44022 turn events so a reader can reconstruct the run from one event.

### 44022 — turn

Content is the raw markdown of one turn (agent reasoning, a summary digest,
or the final writer's certificate). `d` = `<run-id>/<phase>/<agentSlot>` with
1-based phase numbers.

## Run loop (`buzz team run`)

1. Fail closed: `BUZZ_CLASSIFIER_API_URL` / `BUZZ_CLASSIFIER_API_KEY` are
   required (same OpenAI-compatible classifier config as `org contribute
   classify`; `BUZZ_CLASSIFIER_MODEL` defaults to `deepseek-v4-flash-0731`).
2. Fetch the newest revision of the strategy (`d` = `--strategy`), validate
   it again, then execute phases in order. Within a phase, rounds iterate,
   then participants respond in the step's listed order.
3. Per turn: system = teamwork prompt + role prompt + phase prompt (+
   per-agent step prompt when present); user = the problem + conversation so
   far (prior summary-flow digests + this phase's participants' turns).
4. Summary-flow phase: after the phase, its **first listed participant**
   produces the digest (the paper randomizes; slice 1 picks deterministically
   for reproducibility) and it is appended to the transcript and shared.
5. Final writer: one call with the full bounded context produces the
   certificate.
6. Token accounting: per-turn `tokens` come from the provider's
   `usage.total_tokens` when reported, else a chars/4 estimate; `totalTokens`
   is their sum.
7. Preview (default) prints the transcript + final answer + totals. With
   `--publish`, the 44022 turns are published first, then the 44021 run head
   — the run event is authoritative and only exists once every turn
   persisted.

Bounds: max 6 phases / 4 rounds / 6 participants; 30s timeout per LLM call;
`--max-tokens-per-turn` default 700, hard cap 2048; context window re-sent to
the model is capped (most recent turns win). A mid-run LLM failure prints the
partial transcript with a note and fails loud — **nothing partial is ever
published**. Each turn gets exactly one retry; HTTP 429 backs off 5 minutes
before its retry. No global run budget exists yet (slice 2 binds org
budgets).

## Strategy management

- `buzz team strategy put --id <id> --file <json> [--publish]` — strict
  schema validation; previews by default.
- `buzz team strategy get <id>` — newest revision.
- `buzz team strategy list [--limit N]` — newest revision per id.
- `buzz team strategies seed-examples [--publish]` — loads three strategies
  transcribed from the paper's Appendix A (AIME-2024 bank;
  `mechanistic_step_audit`, `independent_solve_then_synthesis`,
  `suspicious_consensus_challenger`), each citing arXiv 2609.22682. The paper
  leaves most AIME role prompts unset ("shown when set"); the SAT DSL requires
  a role prompt per roster slot, so seed roles are derived from the
  strategy's own per-agent instructions where given, and otherwise a neutral
  independent-solver prompt.

## Relay envelope validation

The relay bounds but does not interpret SAT events (mirroring the NIP-ORG
envelope/authority split): exactly one non-empty bounded `d` tag, JSON-object
content for 44020/44021 (bounded ≤64 KiB), non-empty bounded markdown for
44022, no channel scoping. Semantic validation is the CLI's job.

## Slice 2 preview

- **Reflection** (paper §2.2): a designated roster member inspects prior
  strategies, transcripts, per-member answers, and outcomes; proposes
  targeted mutations to roles/phases/synthesis rules; candidate strategies
  are re-run and transfer-validated on probe problems before joining the
  bank. This is the wiki/classifier loop: reflection artifacts and
  revised strategies land as Agent Wiki pages (44002) and new 44020 records.
- **Org binding**: org seats/grants/budgets (NIP-ORG 37010–37012) attach to
  roster slots; grant chains gate who may run strategies on agent seats and
  budget envelopes cap per-run LLM spend (`totalTokens` becomes billable).
