# The manager loop: what the AI manager does, in commands

Status: what works today, 2026-11-19 (rules tightened after review, same day). Loop version: `manager-loop 2` (every draft prints it as `loop_version`).

The AI manager drafts for a project's founder and does nothing else. It reads the project's record, the founder's
answers and three files of the project's brain, and drafts three things: the one thing to do this week, what to leave
aside, and "What happened" for the weekly update. It never drafts "What's next": those lines become signed promises,
so the founder types them. It signs no goal, promise or task step, confirms no work, moves no money and no Shares,
and speaks only to the founder. A person reads every draft and signs the update.

This file is the manager's playbook. Each section below has a name, a version, an owner, a review date, what is
measured and when to retire it. Every command here is checked against the tool's own help by a test
(`launchpad_docs_tests.rs`), so a command that is renamed or removed fails the build instead of staying in this file.
A change to a section goes through an ordinary pull request and raises the version here and in the server
(`LOOP_VERSION`) together; a test holds the two equal.

Set `BUZZ_RELAY_URL` and `BUZZ_PRIVATE_KEY`, and keep `BUZZ_AUTH_TAG` set once an agent account is labelled. Exit
codes: 0 done, 1 bad input or not found, 2 network or the AI service did not answer, 3 refused by the server.

## 1. Set up the manager account

- Name: manager-account
- Version: manager-loop 2
- Owner: the server operator
- Review date: 2027-02-19
- Measure: projects with a labelled manager account, and how many of them are also one of the project's worker agents
  (must be none: the server refuses it).
- Retire if: the server ties an agent's label to its wallet's limits, so that one account can safely be both.

The manager is its own account, never one of the agents that do the work. The role is written once, with the label,
and cannot be changed afterwards.

```bash
# the founder, who runs the manager
buzz agents confirm <MANAGER_PUBKEY>
# the manager, with BUZZ_AUTH_TAG set to the auth_tag printed above
buzz agents label --operator <FOUNDER_PUBKEY> --role manager
buzz agents show <MANAGER_PUBKEY>
```

What the server then holds: a manager account may ask for drafts for projects its founder started, and may sign no
task step at all (take, hand in, confirm, send back). A worker agent may not ask for drafts. Neither may set goals or
promises, or confirm its own work, its founder's work or the work of another agent the same person runs.

A manager needs no wallet and no limits. Daily limits in dollars and Shares are set for worker agents by the project's
runner, in the app (Project, Tasks, Agent limits). Those limits bind a wallet address on the chain; the label binds an
account on the server. Nothing ties the two together today, so keep them apart by hand: never give the manager's
account a wallet with limits.

## 2. The weekly draft

- Name: weekly-draft
- Version: manager-loop 2
- Owner: the server operator
- Review date: 2027-02-19
- Measure: of the drafts asked for, how many lines the founder kept, edited or threw away, counted by section and never
  by person. Not counted by the server yet; until it is, ask five founders by hand.
- Retire if: fewer than one draft in three is kept after four weeks with twenty founders.

1. **Read what the record says.** Goals, the last update and how its promises stand, work accepted since, open help.

   ```bash
   buzz launchpad updates facts <PROJECT> --author <FOUNDER>
   ```

2. **Ask for the draft.** The founder runs it, or the founder's manager account does. Without `--item`, the project's
   30 newest records by its founder are read. `--answer` carries what the founder said when asked (at most five).
   `--brain-dir` is the checkout holding the project's brain.

   ```bash
   buzz launchpad manager draft <PROJECT> --author <FOUNDER> \
     --answer "The demo slipped a week because the venue moved." \
     --brain-dir ./brain
   ```

   The answer is JSON marked `"schema": "creaton.manager.v1"`: `this_week` (one line at most), `not_doing` (one),
   `what_happened` (three), each line with `from` (what it cites: `r1` a record, `a1` an answer, `f1` a line of
   `facts.md`, `d1` a line of `decisions.md`) and `records` (the ids of the records cited). It also carries `read`
   (what was read), `set_aside` (inputs that read like instructions to an AI, never shown to the model),
   `needs_a_person`, `dropped` and `blocked` (lines the server removed, counted), `can_be_wrong` and `notice`.

3. **The founder reads it, types "What's next", and posts.** The manager has no command that posts.

   ```bash
   buzz launchpad updates post <PROJECT> --title "Week 4" \
     --done "<what the founder kept from what_happened>" \
     --next "<typed by the founder>"
   ```

   An operator's own agent may post an update with no promises (`--no-promises`), as in
   [WORKER-LOOP.md](WORKER-LOOP.md). A promise is the founder's.

## 3. What to leave aside

- Name: not-doing
- Version: manager-loop 2
- Owner: the server operator
- Review date: 2027-02-19
- Measure: how often the "not doing" line is kept, and how often the thing left aside shows up as a missed promise four
  weeks later.
- Retire if: founders keep fewer "not doing" lines than "this week" lines for eight weeks running.

The "not doing" line comes from `decisions.md` and from goals in the record, never from the manager's own view of the
project. When a promise is missed, the manager asks what was decided and why; the founder's answer goes back in with
`--answer`, and the founder adds the decision to `decisions.md` by hand, dated. The manager may propose a line for
`facts.md` or `decisions.md` in its draft; it cannot write either file.

```bash
buzz launchpad record <PROJECT> --author <FOUNDER>
buzz launchpad manager draft <PROJECT> --author <FOUNDER> \
  --answer "We decided to stop the second colour: one is cheaper to make." --brain-dir ./brain
```

## 4. This needs a person

- Name: needs-a-person
- Version: manager-loop 2
- Owner: the server operator, with counsel for the wording of the ask
- Review date: 2027-02-19
- Measure: how many drafts carried `needs_a_person`, by topic (legal, tax, sale terms), and how many asks were posted.
- Retire if: counsel says the drafted ask itself reads as advice.

A question about law, tax, or the size and terms of a sale is never answered. The line is removed and the answer
carries `needs_a_person` with the topic and an ask the founder can post as a help request. The same happens when the
question is in the founder's own answer. This is not legal or tax advice, and neither is the ask.

```bash
buzz launchpad updates post <PROJECT> --title "A question for someone qualified" \
  --help-needed "We have a question about tax and need someone qualified to answer it." --no-promises
```

## 5. The project brain

- Name: project-brain
- Version: manager-loop 2
- Owner: the founder of each project (the templates: the server operator)
- Review date: 2027-02-19
- Measure: projects with a brain, the age of the newest dated line in `facts.md`, and drafts whose lines cite a facts
  line.
- Retire if: fewer than one project in five keeps `facts.md` newer than 60 days.

Five plain files in the project's repository: `AGENTS.md`, `facts.md`, `voice.md`, `decisions.md` and `playbooks/`.
The scaffold never overwrites, and `check` refuses a file that looks like it holds a key.

```bash
buzz launchpad brain init --dir ./brain
buzz launchpad brain check --dir ./brain
```

A playbook for one job comes from notes or a transcript of doing it once, written as text under headings (When to use
it, Steps, Checks, Mistakes to avoid). The command copies what sits under those headings into `playbooks/<job>.md`,
keeps any other heading under "Not sorted yet", leaves a section the notes did not cover empty and lists it, and prints
the draft without saving. Running it again with `--save` writes the file, never over an existing one. It calls no AI
service, sends nothing anywhere, reads no audio and refuses notes that look like they hold a key. Not yet tried by real
founders.

```bash
buzz launchpad brain skill --dir ./brain --recording ./notes.md --job order-samples
buzz launchpad brain skill --dir ./brain --recording ./notes.md --job order-samples --save
```

The repository must be bound to a channel or nobody can read it, its author included. Starting a project makes no
channel and no repository today, so the founder does this once by hand:

```bash
buzz repos create --id <REPO_ID> --name "Project brain" --channel <CHANNEL_UUID>
```

The manager is sent `facts.md`, `decisions.md` and `voice.md` as text by whoever asks for the draft. `voice.md` is for
style only and is never a source. A line with `YYYY-MM-DD` still in it is a template line and is not read as a fact.
Nothing in these files is private if the repository is public.

## 6. What a draft costs

- Name: draft-costs
- Version: manager-loop 2
- Owner: the server operator
- Review date: 2027-02-19
- Measure: hosted drafts a week, what they cost, the share of the last 90 days' fees that is, and how many drafts each
  refusal code turned away.
- Retire if: hosted spend stays under 1% of fees for two quarters (then the weekly limit can go).

Hosted drafts go through the server's AI service and the pool every AI feature shares (2,000 calls a day for the
community, 500 an account). The rules, in the order the server checks them (a refusal for the project's week or the
platform's cap never uses up a call of the shared pool: the pool is counted last, and a refusal there gives back the
week's draft and the money set aside):

| The server says (`code`) | Why | What to do |
|---|---|---|
| `ai_manager_founder_only` | Only the founder, or the manager account the founder runs, may ask | Ask as the founder |
| `ai_manager_unmetered` | The operator has not set AI prices, so spend cannot be counted | Operator: set the two price settings |
| `ai_manager_platform_cap` | Hosted spend in the last 90 days would pass 10% of the fees of those 90 days, or the operator's ceiling | Run your own agent on your own AI key, or write it yourself |
| `ai_manager_post_weekly` | Before the first backing round closes, drafts are free while the founder posted a weekly update in the last 14 days (a project younger than 14 days needs none yet) | Post this week's update, then ask again |
| `ai_too_fast`, `ai_limit_account`, `ai_limit_community` | The shared pool's limits | Wait; the answer says how long |
| `ai_manager_own_key` | The project has had this week's hosted drafts (10 unless the operator set another number) | Run your own agent on your own AI key |
| `ai_unavailable` | The AI service did not answer; nothing was counted against the week | Try again later |

A project is new for 14 days from the earlier of its record's date and the first time it asked for a draft, so saving
the record again does not make it new again. A project's first round counts as closed only when the chain reader's
launch log for the record's chain key names this very record; a record that names another project's key gets nothing
from it. The project is counted under one address however the founder's key is written (upper or lower case).

Operator settings, read from the environment only and never from a file in the repository:
`BUZZ_MANAGER_CALLS_PER_WEEK` (default 10), `BUZZ_MANAGER_MAX_CENTS_PER_90_DAYS` (a ceiling in real money on hosted
spend; set it on a test network, where fees are play dollars and the AI bill is not), and the AI service's own
`BUZZ_LLM_PROXY_URL`, `BUZZ_LLM_API_KEY`, `BUZZ_LLM_PRICE_INPUT_CENTS_PER_MTOK` and
`BUZZ_LLM_PRICE_OUTPUT_CENTS_PER_MTOK`. With no fees in the last 90 days the cap is zero and every hosted draft is
refused; whether a new server should have a small fixed floor is the owner's decision and is not built.

## 7. The honesty rules, and their limit

- Name: honesty-envelope
- Version: manager-loop 2
- Owner: the server operator
- Review date: 2027-02-19
- Measure: the planted-record eval passes (in every build with a stand-in model; against the real model before each
  change of model or prompt), and the number of lines dropped and blocked per draft.
- Retire if: never. Loosen a rule only with the eval extended to show what the rule was catching.

The server applies these to every reply before the founder sees it; no client can skip them.

1. A line stays only if it cites something that was read. Inputs that read like instructions to an AI are set aside
   first and can never be cited; so is a line that closes one of the tags the prompt wraps its data in.
2. "What happened" is backed only by what happened: an update's "What happened" and one-line parts, a promise marked,
   accepted work, the founder's answers, and lines of `facts.md` and `decisions.md`. A goal, a promise, what was next
   then, a task or a help request says what was meant, so it can back "this week" and "not doing" and never "What
   happened". Each part of a record is its own source, so a part that happened is never confused with a plan beside it.
3. Returns, price, what Shares are worth, guarantees and moving money are removed, whatever they cite. So is any line
   that tells someone to pay, send, give or buy money, dollars or Shares, any multiplier such as "5x", and a list of
   words for gain, upside, bonus, rising value and money back.
4. Legal, tax and sale questions become "this needs a person" (section 4): law, licences, copyright, privacy, KYC,
   valuation, equity and dilution, and selling, issuing or minting Shares.
5. Every number, link (with or without `https://`), name (a capitalised word, the first word of a sentence included
   unless it is an ordinary opener), date and "no" in a line must be in what it cites, and at least half of its other
   words must be the cited item's own words.
6. Every answer says what was read, that it can be wrong, and that the record was sent to the server's AI service.

The limits, plainly. Rules 3 and 4 are lists of words and phrases, not understanding: a claim of gain or a legal
question put in words that are on no list gets through, and the lists grow when a review finds a gap. Rule 5 checks
words, not meaning, so one invented plain word among real ones gets through ("the lamps passed", where the record says
"tested"), and a name written in lower case is not seen as a name. That is why every answer says it can be wrong and
why a person signs.

The eval runs in every build with a stand-in model that obeys every plant. To run it against the real model, with the
key in the environment and nowhere else:

```bash
scripts/m8-planted-eval.sh
```
