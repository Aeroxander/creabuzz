# Paperclip UX Reference for Buzz Org/DAO Surfaces

**Purpose.** A concrete, implementable UX reference for rebuilding Buzz's DAO/org
surfaces at Paperclip's quality bar. Everything below was read out of the
Paperclip repo (`/Volumes/ExternalSSD/Applications/paperclip`, `ui/src`,
`ui/storybook`, `doc/`, `screenshots/`) and cross-checked against our desktop
app (`creabuzz/desktop/src`). File paths are cited for every claim. Read-only
study; no Paperclip or Buzz files were modified.

**Audience:** anyone touching `desktop/src/features/org`, `features/home`, or
adding org-scoped components to `desktop/src/shared/ui`.

---

## 1. Product principles (quoted, with sources)

From `paperclip/DESIGN.md` ("Product stance"):

> "Paperclip is an operational control plane: org charts, tasks, heartbeat runs,
> budgets, approvals, audit logs. The user is an operator scanning state and
> making decisions. Every screen should answer, in order: *what is happening,
> does it need me, what do I do about it.* Density in service of scanning beats
> whitespace in service of aesthetics — but density comes from information,
> never from chrome."

The eight stated design principles (`paperclip/DESIGN.md` §Principles), the ones
that matter for us:

1. **"One way to say each thing."** One Button, one Card, one Badge, one
   EmptyState. "Variants are props, not new components."
2. **"Tokens are the only source of visual values."** No hex, no raw px, no
   arbitrary Tailwind values in components. Tailwind palette classes
   (`bg-red-500`) "ARE hardcoded values in spirit."
3. **Spacing through tokens;** "vertical rhythm within a container uses one gap
   value, not per-element margins."
4. **"Hierarchy through structure, not decoration."** "A screen should survive
   the removal of one visual layer."
5. **"Status is systematic."** running / paused / blocked / awaiting-approval /
   over-budget "map to a single semantic status token set used identically
   everywhere (badge, row, chart, log). An operator learns the vocabulary once."
6. **"Machine values look machine-made."** IDs, costs, token counts, timestamps
   use the monospace token and shared formatters — never formatted ad hoc.
7. **"Words are part of the system."** One name per concept; buttons name the
   action ("Approve hire", not "Submit"); empty states say what to do first.
8. **"Agent-modifiable by design"** — tokens + lint gates, not 40-file edits.

Contextual feedback rule (`paperclip/DESIGN.md` §Contextual feedback):

> "Do not show a toast for task or run state already visible on the current
> screen. … Show local action results in place; keep failures actionable inline.
> … Expected cancellation is neutral gray, not an error."

From `paperclip/doc/PRODUCT.md` §Specific design goals:

> **"Board-level abstraction always wins."** "The default UI should answer: what
> is the company doing, who is doing it, why does it matter, what did it cost,
> and what needs my approval."
>
> **"Progressive disclosure."** "Top layer: human-readable summary. Middle
> layer: checklist/steps/artifacts. Bottom layer: raw logs/tool calls/transcript."
>
> **"Output-first."** "Work is not done until the user can see the result."
>
> **"Safe autonomy."** "Auto mode is allowed; hidden token burn is not."
>
> **"Time-to-first-success under 5 minutes."**

Also `doc/PRODUCT.md` §Do-not: "Do not lead with raw bash logs and transcripts.
Default view should be human-readable intent/progress, with raw detail beneath."

**Translation for Buzz.** Our org feature is the same product category (an
operator's control plane over delegated agent autonomy) with a different trust
substrate (signed Nostr events instead of a server DB). Every Paperclip
principle above applies unchanged; our extra obligations are provenance
(who signed this node/grant/budget) and relay truth ("The relay is the record",
`creabuzz/docs/nips/NIP-ORG.md` §Principles).

---

## 2. Screen-by-screen breakdown (6 core Paperclip screens)

### 2.1 Dashboard (`ui/src/pages/Dashboard.tsx`, 561 lines)

```
┌────────────────────────────────────────────────────────────────────┐
│ [banner: paused agents / budget incident / no agents — only when]  │
├────────────────────────────────────────────────────────────────────┤
│ ActiveAgentsPanel (who is running right now, live)                 │
├──────────────┬──────────────┬──────────────┬───────────────────────┤
│ MetricCard   │ MetricCard   │ MetricCard   │ MetricCard            │
│ Agents       │ Tasks In     │ Month Spend  │ Pending Approvals     │
│ Enabled      │ Progress     │ $X · %budget │ n · "board review"    │
│ desc: N run, │ desc: N open,│ desc: % of $ │ desc: budget overrides│
│ N paused, N  │ N blocked    │  budget      │  awaiting review      │
│ errors       │              │              │                       │
├──────────────┴──────┬───────┴──────────────┴───────────────────────┤
│ ChartCard: Run      │ ChartCard: Tasks by Status │ ChartCard:      │
│ Activity (14d)      │ (optional: Priority)       │ Success Rate    │
├─────────────────────┴──────────────┬───────────────────────────────┤
│ Recent Activity (ActivityRow list) │ Recent Tasks (10 rows:        │
│                                    │ status glyph · title · id ·   │
│                                    │ assignee · timeAgo)           │
└────────────────────────────────────┴───────────────────────────────┘
```

Information hierarchy, in DOM order (`Dashboard.tsx` render, ~line 315+):

1. **Conditional banners first** — the only things that *block* the company
   run: imported agents parked paused ("N imported agents are paused and will
   not run" + `Resume all` bulk action), all-agents-paused ("nothing will
   run"), active budget incidents ("N active budget incidents · M agents
   paused · K pending budget approvals" + `Open budgets` link), "You have no
   agents" + `Create one here` (`derivePausedAgentBanner`, `Dashboard.tsx:75`).
   Each banner states cause + consequence + one action. Nothing decorative.
2. **Live agents panel** — liveness before numbers.
3. **Four metric cards** (`components/MetricCard.tsx`): big tabular-nums value
   (`text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums`), label,
   *and a sub-description that decomposes the number* ("2 running, 1 paused, 0
   errors"). Every card is a Link to the owning page. Metric cards never
   invent a number they cannot decompose.
4. **Three time-windowed charts** (all "Last 14 days", `ActivityCharts.tsx`).
5. **Two lists**: Recent Activity (event stream) and Recent Tasks, each row =
   StatusIcon + truncated title + monospace id + Identity + `timeAgo`.

Empty states: companyless → `EmptyState` with `Get Started` action that opens
the wizard; agentless companies auto-open onboarding once per company
(`claimOnboardingOffer`, `Dashboard.tsx:140`) — the empty state routes you, it
does not just describe itself.

**What Buzz's org home must answer:** What are my org's agents doing right now
(liveness from kind:44200 turn metrics)? What is blocked on me (kind:46010)?
What has it cost against budgets (kind:37012/37014)? Our current `OrgView.tsx`
answers none of these — it is a tab switcher over two tables.

### 2.2 Org chart (`ui/src/pages/OrgChart.tsx`, 673 lines)

```
┌────────────────────────────────────────────────────────────────────┐
│ [Import organization] [Export organization]        (toolbar row)   │
├────────────────────────────────────────────────────────────────────┤
│ ⌖ viewport (bg-muted/20, border, rounded, cursor grab)             │
│  ┌──────────┐                                                      │
│  │ CEO      │        zoom controls top-right: [+][−][fit]          │
│  │ ●status  │        (size-7 sm, size-9 touch)                     │
│  │ title    │    ┌──────────┐                                      │
│  │ adapter  │────│ CTO      │   SVG edges: orthogonal elbow paths  │
│  │ capabil. │    │ ●status  │   stroke var(--border) w 1.5         │
│  └──────────┘    └──────────┘                                      │
│   Card = 200×100, gap 32×80, padding 60, zoom 0.2–2.0              │
└────────────────────────────────────────────────────────────────────┘
```

Key mechanics (all in `OrgChart.tsx`):

- **Own layout algorithm** (`subtreeWidth`/`layoutTree`/`layoutForest`, lines
  60–130): width-first tree packing, parents centered over children, multiple
  roots side by side. No dependency on a graph library.
- **Interaction set**: pan (drag), wheel zoom *toward the cursor*
  (`handleWheel`, line 331), pinch zoom on touch, "fit to screen", min zoom
  0.2 / max 2.0 (`clampZoom`), touch-move threshold 6px to distinguish tap
  from pan, post-gesture click suppression (400ms, `suppressNextCardClick`).
- **Node card content, in order** (lines ~617–660): agent icon in muted circle
  with **status dot overlaid bottom-right** (`statusDotColor`, 3px card-border
  ring), name (`text-sm font-semibold`), role/title
  (`text-(length:--text-micro)`), adapter type in **monospace nano**,
  capabilities `line-clamp-2` in nano. Four information densities on a 200px
  card without overflow.
- **States**: no company → EmptyState "Select an organization…"; loading →
  `PageSkeleton variant="org-chart"`; empty → EmptyState "No organizational
  hierarchy defined." The chart itself is never rendered in a half-loaded state.
- **Embeddable**: `embedded` prop drops the toolbar and height for reuse inside
  other pages (used by company overview).

**What Buzz's equivalent must answer:** our `org/ui/OrgChart.tsx` renders a
flat indented list, no canvas, no zoom, no fit, no status dots, no spatial
sense of depth. Given kinds 37010 carry `ui.icon`/`ui.color` and an onchain DAO
binding (`orgModels.ts`), our chart should: (a) reuse Paperclip's layout
constants and interaction set nearly verbatim, (b) show attenuation/grant
state on the node (our scope has `canGrant`), (c) mark DAO-bound roots
(OnchainChip) on the node card, not in a separate section.

### 2.3 Approvals (`ui/src/pages/Approvals.tsx` + `components/ApprovalCard.tsx`)

```
┌────────────────────────────────────────────────────────────────────┐
│ Tabs: [Pending (3)]  [All]          ← count badge only on Pending  │
├────────────────────────────────────────────────────────────────────┤
│ ┌ ApprovalCard ─────────────────────────────────────────────────┐  │
│ │ (icon) [TYPE BADGE uppercase micro] Requested by (identity)   │  │
│ │        Subject line (text-base semibold)                      │  │
│ │        Approval request created 2h ago                        │  │
│ │                                   (status pill: 🕐 pending)   │  │
│ │ ───────────────────────────────────────────────────────────── │  │
│ │ ApprovalPayloadRenderer — the actual structured request body  │  │
│ │ ───────────────────────────────────────────────────────────── │  │
│ │ Decision note. <note text> (muted box, when present)          │  │
│ │ ───────────────────────────────────────────────────────────── │  │
│ │ [Approve (green bg)] [Reject (destructive)]   View details →  │  │
│ └───────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

Pattern details:

- Route IS the filter: `/approvals/pending` vs `/approvals/all` (deep-linkable,
  `Approvals.tsx:20`). Pending tab shows a count badge tinted yellow.
- `ApprovalCard` (`ApprovalCard.tsx`) decomposes a request into: type label
  (uppercase micro badge), requester identity chip, subject line as the card's
  h3, relative creation time, a status pill (icon + capitalized words: approved
  green check / rejected red x / revision_requested amber clock / pending
  yellow clock), then the **type-specific payload renderer**
  (`ApprovalPayload.tsx` — one renderer per approval type, so a budget
  override shows amounts and a hire shows the agent profile; the card shell
  never re-renders payloads ad hoc).
- Footer buttons: Approve = solid green (`bg-green-700`), Reject =
  destructive, both with pending-state labels ("Approving…"), plus a quiet
  ghost "View details" link. Mutation errors go to an inline red text line at
  page top (`actionError`), not a toast.
- Empty states are filter-specific: "No pending approvals." vs "No approvals
  yet." (`Approvals.tsx:120`).
- Resolution navigates to `/approvals/{id}?resolved=approved` so the decision
  is visible in place after the action.

**What Buzz's equivalent must answer:** our needs-me surface
(`features/home/useNeedsMeApprovals.ts`, `lib/needsMe.ts`) has the data model
(budget-overrun vs workflow requests, 46010 → 46030/46031 resolution) but
renders inside the inbox as message-like rows. It must become a card list that
shows, per request: type, subject (agent pubkey / workflow), the overrun
numbers (limit, window, counterType — we already parse them), requester, and
two signed actions with inline error surfacing. The resolution tokenHash is
our "detail link" anchor.

### 2.4 What needs me / Decisions (`ui/src/pages/WhatNeedsMe.tsx`, 829 lines)

This is Paperclip's most evolved screen — the model for our inbox:

- **Queue rows, not cards**: `AttentionQueueRow.tsx` renders each attention
  item as an expandable row (Collapsible). Collapsed = one line: status glyph,
  subject, detail line, age. Expanded = full context + **inline resolution**
  (`AttentionInteractionResolver` / `DecisionResolver`) — approve/reject
  without leaving the queue.
- **Toolbar with persisted preferences**: group-by / sort-order / filters are
  loaded from and saved to localStorage per company (`loadAttentionFilters`
  etc., `lib/attention.ts`). Filters never reset when you switch communities.
- **Curtains for history**: decided/expired/snoozed/dismissed items collapse
  into fold-out "curtain" shelves (`DecisionShelf.tsx`, `DecisionQueueRail`)
  instead of disappearing — nothing the operator did is unfindable, but
  nothing stale clutters the open queue.
- **Aging semantics**: `ATTENTION_AGING_DAYS` + `attentionIsAging` — items
  nearing expiry get visual emphasis (a dedicated "Aging" curtain shelf).
- **Keyboard-first**: j/k move, e/x/s act, selection ring drawn **only for
  keyboard selection** (`selectionFromKeyboard` state, `WhatNeedsMe.tsx:80`) —
  a deliberate, documented decision: "the selection ring is the keyboard
  cursor … Clicking used to set it too, which put a ring around the card for
  no reason the operator could act on."
- **Deep links**: `?decisionId=` focuses and expands the referenced card
  (`WhatNeedsMe.tsx:127`).
- **Optimistic hide/restore** with pending sets reset on fresh server truth
  (`pendingHide`/`pendingRestore`, line ~135).
- **Virtualization discipline**: uncapped feeds render a bounded window
  (50 rows, +100 per scroll threshold) with one budget across groups and open
  curtains (`INITIAL_ATTENTION_ROW_RENDER_LIMIT`, line 60).
- **Snooze is first-class**: presets 1 hour / 4 hours / tomorrow 9am / next
  week (`SNOOZE_PRESETS`, `AttentionQueueRow.tsx:63`).

**What Buzz's equivalent must answer:** our inbox
(`features/home/ui/InboxListPane.tsx`, `useNeedsMeApprovals.ts`) mixes
approvals into a message stream. Paperclip's lesson: "needs me" is a *queue
with actions*, not a feed with read states. We need: a dedicated pending-queue
list with inline approve/deny (signing kind:46030/46031), resolution state per
row (pending → resolving → granted/denied — we already model this in
`needsMe.ts` `NeedsMeStatus`), a resolved curtain, and persisted filters.

### 2.5 Costs / budgets (`ui/src/pages/Costs.tsx`, 1131 lines)

```
┌────────────────────────────────────────────────────────────────────┐
│ Date-range presets (Today/Week/Month/…) + custom from/to           │
├──────────┬──────────┬──────────┬───────────────────────────────────┤
│MetricTile│MetricTile│MetricTile│ MetricTile                        │
│Inference │ Budget   │Finance   │ Finance events                    │
│spend $X  │ N inc or │net $Y    │ N · $est estimated                │
│tokens    │ % or Open│debits/   │                                   │
│subtitle  │ paused   │credits   │                                   │
├──────────┴──────────┴──────────┴───────────────────────────────────┤
│ Tabs: Overview | Budgets | Providers | Billers | Finance           │
│                                                                    │
│ OVERVIEW: [incident cards first, if any — BudgetIncidentCard]      │
│  ┌ Inference ledger ────────────┐ ┌ Finance ledger ─────────────┐  │
│  │ $3xl tabular-nums            │ │ Debits/Credits/Net/Est.     │  │
│  │ Budget $B · or Unlimited     │ │ 4 MetricTiles in a grid     │  │
│  │ ▓▓▓▓▓▓▓░░░ utilization bar   │ │                             │  │
│  │ 62% of monthly budget…       │ │                             │  │
│  └──────────────────────────────┘ └─────────────────────────────┘  │
│  ┌ By agent (expandable rows → per-model breakdown) ┐ ┌ Timeline ┐  │
└────────────────────────────────────────────────────────────────────┘
```

Pattern details:

- **The utilization bar is the whole budget UI** (`Costs.tsx:714-729`): a 2px
  bar (`h-2 rounded-full`) whose fill color switches by threshold using the
  same status tokens everywhere — `>90% → --status-task-blocked` (red),
  `>70% → --status-task-todo` (amber), else `--status-task-done` (green) —
  plus one caption line "62% of monthly budget consumed in this range."
  `BudgetPolicyCard.tsx:120` uses the identical trio with
  `role="progressbar"` + aria values. One pattern, reused, accessible.
- **Incidents before ledgers**: `BudgetIncidentCard`s render at the top of
  Overview with two actions — "keep paused" or "raise budget and resume" with
  an amount input (`Costs.tsx:666-680`). A budget incident is phrased as a
  decision to make, not an error to clear.
- **MetricTile vocabulary** (`Costs.tsx:95`): uppercase micro eyebrow label,
  `text-2xl font-semibold tabular-nums` value, one-line muted subtitle that
  decomposes or contextualizes ("N agents paused · M projects paused").
- Every monetary value through `formatCents`, token counts through
  `formatTokens` (DESIGN.md principle 6). Provider/biller tab labels embed
  their own totals in monospace (`ProviderTabLabel`, line 79).
- 30s refetch on budgets (`refetchInterval: 30_000`, line 240) — money data
  self-refreshes; dashboards don't go stale silently.

**What Buzz's equivalent must answer:** our
`org/ui/OrgBudgetConsumption.tsx` already has the right honesty rule
(truncated counts render ">N in window — count is a floor") and a threshold
bar, but lives inside a collapsed row. It must become the paperclip-style
budget surface: utilization bars with the 70/90 thresholds mapped to our
tokens, budget-incident cards driven by kind:46010 overrun requests, and spend
receipts (37014) as a ledger list.

### 2.6 Task thread / board (representative: `IssueRow`, `IssuesList`, `KanbanBoard`, thread components)

The task list row (`IssueRow.tsx`, per `doc/design/COMPONENT-INVENTORY.md`
§2.1): **status glyph → title → chips → assignee → id (mono) → timeAgo**, one
row, container-query driven. Status vocabulary is fixed and canonical:

`backlog · todo · in_progress · in_review · done · blocked · cancelled ·
in_queue` (`components/StatusGlyph.tsx:33`) — each maps to exactly one Lucide
icon from one family (all 24-viewBox circles: dashed, plain, animated spinner
arc, dot, check, minus, ban) and one AA-tuned color var. The thread
(`IssueChatThread.tsx`) keeps conversation attached to the task object, with
rich interaction cards (approvals, tool calls) embedded in the stream
(`IssueThreadInteractionCard.tsx`), blocked-banner when blocked
(`IssueBlockedNotice.tsx`), and a run/cost ledger table (`IssueRunLedger.tsx`).

---

## 3. Onboarding / wizard (`ui/src/components/OnboardingWizard.tsx`, 3145 lines)

Structure worth copying:

- **Numbered step strip with honest labels** (`components/onboarding/Stepper.tsx`):
  steps are `[1, 3, 4, 5]` = "Name your organization → Create your first agent
  → Connect a model → Review". Step 2 (mission) was removed from the walk but
  the numbering still passes through it; positions are *counted*, not indexed,
  so the strip stays truthful on steps the customer never sees (file comment
  explains why). ARIA labels distinguish wizard-step numbers from strip
  positions to avoid announcing "Step 1" twice.
- **The whole wizard is a dialog mounted globally**; the dashboard *opens* it
  rather than navigating (`Dashboard.tsx:140-155`), so an empty company
  funnels straight into it with zero route races. Auto-open once per company
  (`claimOnboardingOffer`).
- **Each step creates real state immediately**: step 1 creates the company on
  name entry (`handleCreateCompany`), step 3 creates the agent, step 4 wires
  the model connection with per-adapter login cards, step 5 "review" then
  launches to a dashboard that is already alive. Landing state is verified —
  `launchStateIncomplete` guards a half-created launch (`OnboardingWizard.tsx:2340`).
- **Motion as tokens**: `components/onboarding/onboarding-motion.ts` exports
  beat delays / card enter-exit variants; `prefers-reduced-motion` collapses
  at the token layer (DESIGN.md §Motion tokens).
- `ui/storybook/prototypes/NewAgentWizard.tsx` + `wizard-preview-main.tsx` are
  the preview harnesses; `App.onboarding-launcher.test.tsx` covers the
  routing rules (agentless company → wizard at the right step).

**Buzz mapping:** "create org" in Buzz is publishing the first kind:37010 node
(plus community binding). Our wizard should be: name org → create first node →
(optionally) grant to first agent (37011) → set first budget (37012) → review
summary that shows the four signed events. Paperclip's "empty state opens the
wizard" rule maps to: an org chart with zero nodes auto-offers the wizard.

---

## 4. Component inventory — what Paperclip has that `desktop/src/shared/ui` lacks

Existing in Buzz `desktop/src/shared/ui` (verified by listing the directory):
button, badge, card, dialog, alert-dialog, dropdown-menu, popover, sheet,
tabs, input, textarea, checkbox, switch, toggle, tooltip, separator,
skeleton, progress, avatar, calendar, carousel, command-adjacent
(chooser-dialog-content), segmented-control, step-progress, sonner (toast),
markdown, VirtualizedList, PortalledScrollArea, PageHeader, PanelSectionGroup,
UnreadPill, UserAvatar, PubKey, Spinner, BuzzLoadingState, ViewLoadingFallback.

Missing, mapped to Paperclip sources and our consumers:

| Needed component | Paperclip reference | Buzz consumer |
|---|---|---|
| `EmptyState` (icon + title + message + one CTA) | `components/EmptyState.tsx` (51 lines; used by Dashboard, OrgChart, Approvals, Costs) | `org/ui/OrgChart.tsx` currently hand-rolls a paragraph + button |
| `StatusGlyph` + `StatusBadge` (one icon family + one color map per status) | `StatusGlyph.tsx`, `StatusBadge.tsx`, `lib/status-colors.ts` | every org/approval row; today each file invents its own icon+color |
| `MetricCard` / `MetricTile` (value + label + decomposition subtitle, optional link) | `MetricCard.tsx`, `Costs.tsx:95` | org summary, future org home |
| `InlineBanner` (tone + icon + title + body + action slot) | `components/InlineBanner.tsx` | budget incidents, paused/revoked states |
| `PageSkeleton` with per-page variants | `components/PageSkeleton.tsx` (variant prop) | org view currently shows "Loading org chart..." text |
| `PageTabBar` (tab + count badge, route-synced) | `components/PageTabBar.tsx` | OrgView tabs, needs-me filters |
| `Progress` with status-token fill + aria (we have `progress.tsx`; add the 70/90 semantic wrapper) | `BudgetPolicyCard.tsx:107-135` | `OrgBudgetConsumption.tsx` (already does thresholds, needs extraction) |
| `FilterBar` / toolbar with persisted filter state | `components/FilterBar.tsx`, `lib/attention.ts` localStorage pattern | needs-me queue |
| `Collapsible` row + curtain shelf | `AttentionQueueRow.tsx`, `DecisionShelf.tsx` | needs-me resolved history |
| `Identity` chip (avatar + name inline) | `components/Identity.tsx` | grant chain (we render raw `PubKey` chips everywhere) |
| `ChartCard` + small status/sparkline charts | `components/ActivityCharts.tsx` | budget consumption trend, contribution activity |
| `CommandPalette` (⌘K) | `components/CommandPalette.tsx` | org-wide jump-to-node/grant |
| `KeyboardShortcutsCheatsheet` | same file | needs-me queue keyboard actions |
| `radio-card` (large selectable option card) | `components/ui/radio-card.tsx` | org wizard node-kind picker (role/team/agent_seat) |

Note what Paperclip deliberately does NOT have: no chart library cult — charts
are bespoke SVG in `ActivityCharts.tsx`; no data-grid library — tables are
divs with divide-y. Match that; our `ContributionRecordsTable.tsx` should stay
a plain table.

---

## 5. Visual system

**Tokens.** Paperclip: single source `ui/src/index.css` (Tailwind v4 `@theme`,
~80+ tokens, three tiers — semantic shadcn set, brand tier
(`--agent-1a..10b` gradients, `--status-task-*`/`--status-agent-*`), domain
tier). Buzz already has a token surface in `desktop/tailwind.config.js` and
rem-only text rules in AGENTS.md; the missing piece is the **status tier**.
Define `--status-*` equivalents once (in tailwind config or a CSS file) and
route every status color through them:

- Paperclip status hues (`index.css`, WCAG-tuned, light/dark):
  `--status-task-backlog #a8aeb2 · todo #f59e0b · in_progress #2563eb ·
  in_review #7c3aed · done #22c55e · blocked #dc2626 · cancelled #a8aeb2`;
  agent: idle gray, running blue, paused amber, error red. Dark mode re-tunes
  per-token (e.g. `--status-task-icon-todo: #fbbf24` dark, `#cc7a00` light for
  3:1 contrast).
- **Color semantics**: *blue = liveness* (in_progress/running), *amber/yellow =
  waiting or attention* (todo, pending, paused, warning), *red = blocking or
  failing* (blocked, error, over-budget hard stop), *green = done/healthy*,
  *violet = in review*, *gray = neutral/terminal-cancelled*. Budget thresholds
  reuse the same hues: <70% green, 70–90% amber, >90% red.
- Brand chip recipe (`lib/status-colors.ts` `brandChipBadge`): 1px border,
  low-alpha bg, saturated text, dark variants at ~14% alpha
  (`dark:bg-[#2563eb2e]`).

**Density & spacing.** Rows are compact (`px-2 py-1.5` grant rows in our code
is already close); cards use `p-4`/`p-5`; sections separated by one consistent
gap per container (DESIGN.md principle 3), never mixed margins+gap. Lists use
`divide-y`, not bordered cards per row.

**Typography hierarchy** (consistent across screens): page content = `text-sm`
base; card titles = `text-base font-semibold`; metric values = `text-2xl/3xl
font-semibold tabular-nums`; section eyebrows = `text-(micro) uppercase
tracking-(caps) text-muted-foreground`; machine values (ids, cents, tokens,
timestamps) = `font-mono text-(micro|nano)`. Map to our ramp: `text-sm`,
`text-base`, `text-2xl`, `text-2xs`/`text-3xs` (we already have `text-2xs`
and `text-3xs` tokens — use them instead of Paperclip's `--text-micro/nano`).

**Iconography.** One Lucide family, one glyph per concept (`StatusGlyph.tsx`
draws the entire status set from same-viewBox circle variants so they read as
a family). Status never expressed by icon alone — always glyph + word or
glyph + color + tooltip/aria (`StatusGlyph` takes `title`, sets
`role="img"`).

**Machine values.** `formatCents` / `formatTokens` / `timeAgo` shared helpers;
ids shown as short monospace slices (`issue.id.slice(0, 8)`). Buzz
equivalents: pubkey → `PubKey` component (exists), amounts → one shared
formatter, times → one `timeAgo` (we have one in shared lib — verify single
source).

---

## 6. End-to-end DAO journey on Buzz kinds (what the user sees at each step)

Event vocabulary (from `creabuzz/desktop/src/shared/constants/kinds.ts` and
`docs/nips/NIP-ORG.md`): 37010 node, 37011 grant, 37012 budget, 37013
contribution record, 37014 spend receipt, 46010 approval request → 46030/46031
grant/deny (the UI's `lib/needsMe.ts` local aliases; the NIP documents
46011/46012), 44200 agent turn metrics, onchain binding on node
`content.onchain {chain, dao}` and budget spend ceiling `onchain {chain,
contract, subject}`.

1. **Create org** → publish root kind:37010 (`kind: "role"`, no parent).
   UI: the auto-opened org wizard (§3). Step complete = event accepted
   (`{event_id, accepted}` write receipt). Show the d-tag/id in monospace and
   the author pubkey as signer identity — the relay is the record.
2. **Build structure** → child 37010 nodes (role/team/agent_seat) with
   `scope {readBelow, assignBelow, canGrant}`. UI: org chart canvas (§2.2)
   with status dots; node cards show holders (human pubkeys) and agentSeats;
   `ui.icon`/`ui.color` content fields drive the avatar, like Paperclip's
   `AgentIconPicker`.
3. **Delegate authority** → kind:37011 grants with `parentGrant` chains and
   verb attenuation. UI: grant chain view (our `OrgGrantChainView.tsx` already
   has the right idea: indentation per depth, dashed border for non-root,
   verb badges, attenuation check/triangle via `verbEntailedBy`). Upgrade:
   move from tree list to overlay-on-chart or side drawer; expired grants
   render with the amber clock treatment Paperclip uses for
   `revision_requested`; revoked grants collapse into a "revoked" curtain,
   never deleted from view (transitive invalidation must be visible).
4. **Cap autonomy** → kind:37012 budgets (`limits.spend/runs/tasks`,
   `window epoch|day|week|month`, `onExceed: "require-approval"`). UI:
   `BudgetPolicyCard` pattern — Observed vs Budget tiles, remaining, the
   threshold progress bar, "Soft alert at N%".
5. **Agents run** → kind:44200 turn metrics accumulate. UI: consumption bars
   computed like our `OrgBudgetConsumption.tsx` (with the truncated-floor
   honesty rule), surfaced on the org home metric row and per-node card dot.
6. **Overrun → needs me** → relay emits kind:46010
   (`{type:"budget-exceeded", subject, counterType, window, limit}`, `d` =
   token hash, `p` = budgeted agent). UI: needs-me queue card (§2.3): type
   badge "Budget override", subject identity, the four overrun numbers in the
   payload area, Approve/Deny signing kind:46030/46031 with the token hash
   echoed in `d`. Inline error on OK-frame rejection (relay-side ACL).
7. **Spend settles** → kind:37014 spend receipts; onchain-bound budgets
   additionally show the allowance contract binding
   (`OnchainChip`, `org/ui/OnchainChip.tsx`). UI: costs/budgets ledger
   (§2.5) — utilization bar, incident cards for unresolved 46010s, receipt
   list with mono amounts.
8. **Bind DAO** → org root node republished (NIP-33 replacement) with
   `content.onchain {chain, dao, boundAt}`; budgets may bind spend ceilings to
   onchain allowances. UI: OnchainChip on the root node card and a
   "Bound to DAO …" line in the org summary; Paperclip-equivalent = the
   Import/Export toolbar row becomes "DAO binding" status row. This is the
   moment the org summary bar should read like the Dashboard metric row:
   N nodes · N grants · N budgets · treasury contract · chain.
9. **Contribution history** → kind:37013 records. UI: contributions table
   becomes a per-contributor profile feed (Paperclip's Recent Activity list
   pattern: ActivityRow = who did what to which object, timeAgo), plus the
   chart treatment for volume over time.

---

## 7. Prioritized rebuild list

### P0 — the operator loop (needs-me + budget truth)

1. **Needs-me approval cards with inline resolution** — rebuild the inbox
   needs-me section as an ApprovalCard-style queue.
   Files: new `desktop/src/features/home/ui/NeedsMeApprovalCard.tsx`; rework
   `desktop/src/features/home/ui/InboxListPane.tsx` /
   `InboxDetailPane.tsx` needs-me paths; actions in
   `useNeedsMeApprovals.ts` (already has `resolving` local state); shared
   status pill from new `desktop/src/shared/ui/StatusBadge.tsx`.
2. **Status token tier + `StatusGlyph`/`StatusBadge`** — define the semantic
   status palette (blue=liveness, amber=waiting, red=blocking, green=ok,
   violet=review, gray=neutral) once in `desktop/tailwind.config.js`
   (theme.extend) and add `desktop/src/shared/ui/StatusGlyph.tsx` +
   `StatusBadge.tsx`. Everything in P0/P1 consumes this.
3. **Budget utilization surface with thresholds** — promote
   `OrgBudgetConsumption` logic into a shared
   `desktop/src/shared/ui/UtilizationBar.tsx` (role=progressbar, 70/90
   thresholds, honesty rule for truncated counts) and render one per budget
   on the org chart summary + a budgets section header.
   Files: `desktop/src/shared/ui/UtilizationBar.tsx` (new),
   `features/org/ui/OrgBudgetConsumption.tsx`,
   `features/org/ui/OrgChart.tsx` (summary bar).

### P1 — the org canvas + empty states

4. **Org chart canvas** — port Paperclip's layout + pan/zoom/pinch/fit
   (`ui/src/pages/OrgChart.tsx` constants: CARD_W 200, CARD_H 100, GAP 32×80,
   zoom 0.2–2.0, elbow SVG edges) into
   `desktop/src/features/org/ui/OrgChart.tsx` (replace the indented list).
   Node card = icon+status dot, name, kind label, seat count, DAO-binding
   chip when `node.onchain` exists.
5. **`EmptyState`, `MetricCard`, `InlineBanner`, `PageSkeleton` in shared/ui**
   — port the four small primitives; convert `OrgView.tsx` loading/error/empty
   branches and `OrgChart.tsx` empty state.
6. **Org summary metric row** — replace the current "N nodes N grants N
   budgets" text line with four MetricCards (Nodes, Active grants, Budgets
   with utilization, Needs-attention count linking to needs-me).
   File: `features/org/ui/OrgChart.tsx`.
7. **Needs-me persisted filters + resolved curtain** — group/sort persisted
   per community (Paperclip `lib/attention.ts` localStorage pattern);
   resolved 46030/46031 rows fold into a curtain shelf.
   Files: `features/home/ui/InboxFilterMenu.tsx`, new
   `NeedsMeCurtain.tsx`, `lib/needsMe.ts` (resolution fetch already exists).

### P2 — depth and polish

8. **Onboarding wizard for org creation** — numbered step strip (Name org →
   First node → First grant → First budget → Review), auto-opened from an
   empty org chart, each step publishing the real event. New
   `desktop/src/features/org/ui/OrgWizard.tsx`; reuse
   `shared/ui/step-progress.tsx`.
9. **Keyboard queue actions** on needs-me (j/k/e/x semantics, selection ring
   only for keyboard focus), plus a shortcuts cheatsheet. Files: new
   `shared/ui/KeyboardShortcutsCheatsheet.tsx`, needs-me list component.
10. **Contribution activity feed + charts** — convert
    `ContributionRecordsTable.tsx` into rows in the ActivityRow pattern plus
    a small volume chart (`ChartCard` port of `ActivityCharts.tsx`).
11. **Grant chain drawer + revocation curtain** — move grant detail into a
    Sheet (shared/ui/sheet.tsx exists); revoked/expired grants into a
    collapsible shelf instead of inline rows.
    File: `features/org/ui/OrgGrantChainView.tsx`.
12. **⌘K palette scoped to org objects** (jump to node/grant/budget) — port
    `CommandPalette.tsx` shape onto `shared/ui` primitives.

### Cross-cutting rules for all of the above (from DESIGN.md, enforced in review)

- No new hardcoded status colors; route through the P0 token tier.
- No toasts for state visible on-screen; inline errors for failed event
  publishes (the relay OK-frame message belongs next to the action).
- Every empty state names the first action; every banner states cause,
  consequence, and one action.
- Machine values (event ids, pubkeys, amounts, tokenHashes) always monospace
  via shared formatters.
- One name per concept across the org surfaces: *node*, *grant*, *budget*,
  *request* — never mixed synonyms (Paperclip's "task not issue" rule).
